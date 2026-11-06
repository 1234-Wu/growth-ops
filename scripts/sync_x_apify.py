#!/usr/bin/env python3
"""Synchronize Twitter / X scraped data from Apify into Growth Ops backend.

Supports:
1. Direct fetch from Apify Dataset / Task API using API Token.
2. Local JSON file import (--input-file path/to/dataset.json).
3. Dual backend engine:
   - Direct SQLite database update (default, fast, offline-safe, transactions)
   - HTTP API client mode (--api, connects to running server.py)
4. Automatic deduplication of contents and actions by tweet ID / URL.
5. Recording cumulative metrics (views, likes, retweets, replies, bookmarks)
   with precise timestamps for the Operations Data (运营数据) page.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
from typing import Any
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB_FILE = ROOT / "data" / "growth.sqlite3"
DEFAULT_KEY_FILE = ROOT / "data" / "api-key"
DEFAULT_BASE_URL = os.environ.get("GROWTH_API_URL", "http://127.0.0.1:8787/api/v1")

sys.path.insert(0, str(ROOT))
import server  # type: ignore[import-not-found]


class GrowthDirectDb:
    """Direct database adapter using server.py verification and schema rules."""

    def __init__(self, db_path: Path):
        self.conn = sqlite3.connect(str(db_path))
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys = ON")

    def get_accounts(self) -> list[dict[str, Any]]:
        rows = self.conn.execute("SELECT * FROM records WHERE resource = 'accounts'").fetchall()
        return [server.row_to_record(r) for r in rows]

    def get_actions(self) -> list[dict[str, Any]]:
        rows = self.conn.execute("SELECT * FROM records WHERE resource = 'actions'").fetchall()
        return [server.row_to_record(r) for r in rows]

    def insert(self, resource: str, payload: dict[str, Any]) -> dict[str, Any]:
        server.validate_write_payload(payload)
        record = server.build_record(resource, payload)
        server.validate_refs(self.conn, resource, record)
        server.insert_record(self.conn, record)
        return record

    def commit(self) -> None:
        self.conn.commit()

    def close(self) -> None:
        self.conn.close()


class GrowthApiClient:
    """HTTP client adapter communicating with Growth Ops API."""

    def __init__(self, base_url: str, api_key: str):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        # Bypass local proxy when communicating with localhost
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def request(
        self,
        method: str,
        path: str,
        params: dict[str, Any] | None = None,
        data: dict[str, Any] | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        url = f"{self.base_url}/{path.lstrip('/')}"
        if params:
            query = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
            if query:
                url = f"{url}?{query}"

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Accept": "application/json",
        }
        body_bytes = None
        if data is not None:
            headers["Content-Type"] = "application/json"
            body_bytes = json.dumps(data, ensure_ascii=False).encode("utf-8")
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key

        req = urllib.request.Request(url, data=body_bytes, headers=headers, method=method)
        try:
            with self.opener.open(req, timeout=30) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as err:
            err_body = err.read().decode("utf-8")
            raise RuntimeError(f"API error {err.code} on {method} {url}: {err_body}") from err


def fetch_apify_items(
    token: str,
    dataset_id: str | None = None,
    task_id: str | None = None,
) -> list[dict[str, Any]]:
    """Fetch items from Apify API via dataset ID or latest run of a task."""
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    if task_id and not dataset_id:
        url = f"https://api.apify.com/v2/actor-tasks/{task_id}/runs/last?status=SUCCEEDED"
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=30) as resp:
            run_data = json.loads(resp.read().decode("utf-8"))
        dataset_id = run_data.get("data", {}).get("defaultDatasetId")
        if not dataset_id:
            raise RuntimeError(f"Could not find defaultDatasetId for task {task_id}")

    if not dataset_id:
        raise ValueError("Either dataset_id or task_id must be provided")

    url = f"https://api.apify.com/v2/datasets/{dataset_id}/items?clean=true&format=json"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def parse_iso_time(val: Any) -> str | None:
    if not val:
        return None
    s = str(val).strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.isoformat()
    except ValueError:
        pass
    try:
        # Twitter API format: "Wed Sep 09 09:51:00 +0000 2026"
        dt = datetime.strptime(s, "%a %b %d %H:%M:%S %z %Y")
        return dt.isoformat()
    except (ValueError, TypeError):
        return None


def get_current_iso_time() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat()


def extract_tweet_id_from_url(url: str) -> str | None:
    match = re.search(r"/status/(\d+)", url)
    return match.group(1) if match else None


def first_present(raw: dict[str, Any], *keys: str) -> Any:
    """Return the first supplied value without treating numeric zero as missing."""
    for key in keys:
        value = raw.get(key)
        if value is not None and value != "":
            return value
    return None


def normalize_apify_tweet(raw: dict[str, Any]) -> dict[str, Any]:
    """Normalize fields across Apify Twitter Scrapers and Twitter Exporter CSV."""
    tweet_id = str(raw.get("id") or raw.get("id_str") or "")
    url = raw.get("url") or raw.get("twitterUrl") or ""
    if not tweet_id and url:
        tweet_id = extract_tweet_id_from_url(url) or ""
    if not url and tweet_id:
        url = f"https://x.com/i/status/{tweet_id}"

    text = raw.get("text") or raw.get("full_text") or raw.get("tweet_text") or ""
    created_at = parse_iso_time(raw.get("createdAt") or raw.get("created_at"))

    author_handle = str(raw.get("username") or "")
    author_followers = None
    author = raw.get("author") or raw.get("user") or {}
    if isinstance(author, dict):
        author_handle = author.get("userName") or author.get("username") or author.get("screen_name") or author_handle
        author_followers = author.get("followers") or author.get("followersCount") or author.get("followers_count")

    conversation_id = str(raw.get("conversation_id") or raw.get("conversationId") or "") or None
    in_reply_to_status_id = str(
        raw.get("inReplyToStatusId")
        or raw.get("in_reply_to_status_id")
        or raw.get("in_reply_to_status_id_str")
        or ""
    ) or None
    in_reply_to_screen_name = str(
        raw.get("inReplyToScreenName")
        or raw.get("in_reply_to_screen_name")
        or ""
    ).lstrip("@") or None
    source_type = str(raw.get("tweet_type") or raw.get("type") or "").strip().lower()
    is_reply = bool(
        raw.get("isReply")
        or in_reply_to_status_id
        or source_type == "reply"
    )
    is_retweet = bool(
        source_type in {"retweet", "repost"}
        or raw.get("retweetedStatusId")
        or raw.get("retweeted_status_id")
        or raw.get("retweeted_status")
        or raw.get("is_retweet")
        or str(text).startswith("RT @")
    )
    is_quote = bool(
        source_type in {"quote", "quoted"}
        or raw.get("quotedStatusId")
        or raw.get("quoted_status_id")
        or raw.get("quoted_status")
        or raw.get("isQuote")
        or raw.get("is_quote_status")
    )
    if is_reply:
        tweet_type = "reply"
    elif is_retweet:
        tweet_type = "retweet"
    elif is_quote:
        tweet_type = "quote"
    else:
        tweet_type = "original"

    return {
        "tweet_id": tweet_id,
        "url": url,
        "text": text,
        "created_at": created_at,
        "author_handle": author_handle.lstrip("@"),
        "author_followers": author_followers,
        "views": first_present(raw, "view_count", "viewCount", "views"),
        "likes": first_present(raw, "favorite_count", "likeCount", "likes"),
        "retweets": first_present(raw, "retweet_count", "retweetCount", "retweets"),
        "replies": first_present(raw, "reply_count", "replyCount", "replies"),
        "bookmarks": first_present(raw, "bookmark_count", "bookmarkCount", "bookmarks"),
        "is_reply": is_reply,
        "tweet_type": tweet_type,
        "conversation_id": conversation_id,
        "in_reply_to_status_id": in_reply_to_status_id,
        "in_reply_to_screen_name": in_reply_to_screen_name,
    }


def sync_twitter_items(
    raw_items: list[dict[str, Any]],
    *,
    db_file: Path = DEFAULT_DB_FILE,
    account_id: str | None = None,
    dry_run: bool = False,
    api_client: GrowthApiClient | None = None,
) -> dict[str, int]:
    """Sync list of parsed/raw Twitter items into SQLite database or API client."""
    if not raw_items:
        return {
            "synced_posts": 0,
            "synced_metrics": 0,
            "skipped_external": 0,
            "skipped_missing_author": 0,
            "skipped_missing_id": 0,
        }

    direct_db: GrowthDirectDb | None = None
    if api_client:
        accounts = api_client.request("GET", "accounts", params={"limit": 100}).get("items", [])
        existing_actions = api_client.request("GET", "actions", params={"limit": 200}).get("items", [])
    else:
        if not db_file.exists():
            raise FileNotFoundError(f"Database {db_file} not found.")
        direct_db = GrowthDirectDb(db_file)
        accounts = direct_db.get_accounts()
        existing_actions = direct_db.get_actions()

    account_map: dict[str, str] = {}
    account_by_id: dict[str, dict[str, Any]] = {}
    for acc in accounts:
        data = acc.get("data") or {}
        handle = data.get("handle", "").lower().lstrip("@")
        account_by_id[acc["id"]] = acc
        if handle:
            account_map[handle] = acc["id"]

    explicit_account_handle: str | None = None
    if account_id:
        selected_account = account_by_id.get(account_id)
        if selected_account is None:
            raise ValueError(f"Account {account_id} not found")
        selected_data = selected_account.get("data") or {}
        explicit_account_handle = str(selected_data.get("handle") or "").lower().lstrip("@")
        if not explicit_account_handle:
            raise ValueError(f"Account {account_id} has no configured handle")

    action_by_ext_id: dict[str, dict[str, Any]] = {}
    for act in existing_actions:
        data = act.get("data") or {}
        ext_id = str(data.get("external_id") or "")
        evidence_url = str(data.get("evidence_url") or "")
        if ext_id:
            action_by_ext_id[ext_id] = act
        elif evidence_url:
            matched_id = extract_tweet_id_from_url(evidence_url)
            if matched_id:
                action_by_ext_id[matched_id] = act

    now_iso = get_current_iso_time()
    observed_date = now_iso[:10]
    synced_posts = 0
    synced_metrics = 0
    skipped_external = 0
    skipped_missing_author = 0
    skipped_missing_id = 0

    for raw in raw_items:
        tweet = normalize_apify_tweet(raw)
        tweet_id = tweet["tweet_id"]
        if not tweet_id:
            skipped_missing_id += 1
            continue

        author = tweet["author_handle"].lower()
        if not author:
            skipped_missing_author += 1
            continue
        if account_id:
            if author != explicit_account_handle:
                skipped_external += 1
                continue
            target_acc_id = account_id
        else:
            target_acc_id = account_map.get(author)

        if not target_acc_id:
            skipped_external += 1
            continue

        if tweet.get("is_retweet"):
            skipped_external += 1
            continue

        action_record = action_by_ext_id.get(tweet_id)
        action_id = action_record["id"] if action_record else None

        if not action_id:
            content_title = (tweet["text"].strip().splitlines() or ["推文"])[0][:60]
            if dry_run:
                print(f"[DRY-RUN] Create content & action for tweet {tweet_id}: {content_title}")
                action_id = f"dry-run-action-{tweet_id}"
            else:
                c_payload = {
                    "title": content_title,
                    "account_id": target_acc_id,
                    "status": "active",
                    "data": {
                        "body": tweet["text"],
                        "platform_content_id": tweet_id,
                        "platform_id": "platform-x",
                    },
                }
                if api_client:
                    c_res = api_client.request("POST", "contents", data=c_payload, idempotency_key=f"content-{tweet_id}")
                    content_id = c_res.get("item", {}).get("id")
                else:
                    assert direct_db is not None
                    c_res = direct_db.insert("contents", c_payload)
                    content_id = c_res["id"]

                action_type = {
                    "reply": "reply",
                    "retweet": "repost",
                    "quote": "quote",
                    "original": "publish",
                }[tweet["tweet_type"]]
                a_payload = {
                    "title": f"发布推文: {content_title}",
                    "account_id": target_acc_id,
                    "status": "completed",
                    "data": {
                        "action_type": action_type,
                        "source_tweet_type": tweet["tweet_type"],
                        "content_id": content_id,
                        "evidence_url": tweet["url"],
                        "external_id": tweet_id,
                        "occurred_at": tweet["created_at"] or now_iso,
                        "publication_state": "published",
                        "verification_status": "verified",
                        "verification_evidence": tweet["url"],
                        "verified_at": now_iso,
                        "conversation_id": tweet["conversation_id"],
                        "in_reply_to_status_id": tweet["in_reply_to_status_id"],
                        "in_reply_to_screen_name": tweet["in_reply_to_screen_name"],
                    },
                }
                if api_client:
                    a_res = api_client.request("POST", "actions", data=a_payload, idempotency_key=f"action-{tweet_id}")
                    action_record = a_res.get("item", {})
                else:
                    assert direct_db is not None
                    action_record = direct_db.insert("actions", a_payload)

                action_id = action_record.get("id")
                action_by_ext_id[tweet_id] = action_record
                synced_posts += 1

        metrics_to_record = [
            ("views", tweet["views"]),
            ("likes", tweet["likes"]),
            ("retweets", tweet["retweets"]),
            ("replies", tweet["replies"]),
            ("bookmarks", tweet["bookmarks"]),
        ]

        for metric_name, val in metrics_to_record:
            if val is None:
                continue
            try:
                if isinstance(val, str):
                    val = val.replace(",", "").strip()
                num_val = int(float(val))
            except (ValueError, TypeError):
                continue

            m_payload = {
                "title": f"{observed_date} {metric_name} 快照",
                "account_id": target_acc_id,
                "product_id": action_record.get("product_id") if action_record else None,
                "status": "active",
                "data": {
                    "action_id": action_id,
                    "metric_name": metric_name,
                    "value": num_val,
                    "availability": "valid",
                    "metric_type": "cumulative",
                    "observed_at": now_iso,
                    "observed_on": observed_date,
                    "source": "twitter_exporter",
                },
            }
            if dry_run:
                print(f"  [DRY-RUN] Record metric {metric_name}={num_val} for action {action_id}")
            else:
                if api_client:
                    api_client.request("POST", "metrics", data=m_payload, idempotency_key=f"m-{action_id}-{metric_name}-{observed_date}")
                else:
                    assert direct_db is not None
                    direct_db.insert("metrics", m_payload)
                synced_metrics += 1

        if tweet["author_followers"] is not None:
            try:
                f_raw = tweet["author_followers"]
                if isinstance(f_raw, str):
                    f_raw = f_raw.replace(",", "").strip()
                f_val = int(float(f_raw))
                f_payload = {
                    "title": f"{observed_date} 粉丝数快照",
                    "account_id": target_acc_id,
                    "status": "active",
                    "data": {
                        "metric_name": "followers",
                        "value": f_val,
                        "availability": "valid",
                        "metric_type": "cumulative",
                        "observed_at": now_iso,
                        "observed_on": observed_date,
                        "source": "apify",
                    },
                }
                if not dry_run:
                    if api_client:
                        api_client.request("POST", "metrics", data=f_payload, idempotency_key=f"f-{target_acc_id}-{observed_date}")
                    else:
                        assert direct_db is not None
                        direct_db.insert("metrics", f_payload)
            except (ValueError, TypeError):
                pass

    if direct_db and not dry_run:
        direct_db.commit()
        direct_db.close()

    return {
        "synced_posts": synced_posts,
        "synced_metrics": synced_metrics,
        "skipped_external": skipped_external,
        "skipped_missing_author": skipped_missing_author,
        "skipped_missing_id": skipped_missing_id,
    }


def sync_file(file_path: Path, **kwargs: Any) -> dict[str, int]:
    """Parse CSV or JSON file and sync items."""
    if not file_path.exists():
        raise FileNotFoundError(f"File {file_path} not found.")
    if str(file_path).lower().endswith(".csv"):
        import csv
        with open(file_path, "r", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            raw_items = list(reader)
    else:
        with open(file_path, "r", encoding="utf-8") as f:
            raw_items = json.load(f)
    return sync_twitter_items(raw_items, **kwargs)


def main() -> int:
    parser = argparse.ArgumentParser(description="Sync Twitter data from Apify or CSV to Growth Ops")
    parser.add_argument("--api", action="store_true", help="Use HTTP API instead of direct SQLite DB")
    parser.add_argument("--base", default=DEFAULT_BASE_URL, help="Growth Ops API base URL")
    parser.add_argument("--db-file", type=Path, default=DEFAULT_DB_FILE, help="Path to growth.sqlite3")
    parser.add_argument("--key-file", type=Path, default=DEFAULT_KEY_FILE, help="Path to data/api-key")
    parser.add_argument("--account-id", help="Target Growth Ops account ID (defaults to matched handle)")
    parser.add_argument("--input-file", type=Path, help="Import from local Apify JSON or Twitter Exporter CSV file")
    parser.add_argument("--token", default=os.environ.get("APIFY_TOKEN"), help="Apify API Token")
    parser.add_argument("--dataset-id", default=os.environ.get("APIFY_DATASET_ID"), help="Apify Dataset ID")
    parser.add_argument("--task-id", default=os.environ.get("APIFY_TASK_ID"), help="Apify Task ID")
    parser.add_argument("--dry-run", action="store_true", help="Preview sync actions without writing")
    args = parser.parse_args()

    target_file = args.input_file
    default_import_file = ROOT / "data" / "imports" / "twitter.csv"
    if not target_file and not args.token and default_import_file.exists():
        target_file = default_import_file
        print(f"Auto-detected import file: {target_file}")

    raw_items: list[dict[str, Any]] = []
    if target_file:
        if not target_file.exists():
            print(f"Error: input file {target_file} not found.", file=sys.stderr)
            return 1
        if str(target_file).lower().endswith(".csv"):
            import csv
            with open(target_file, "r", encoding="utf-8-sig") as f:
                reader = csv.DictReader(f)
                raw_items = list(reader)
        else:
            with open(target_file, "r", encoding="utf-8") as f:
                raw_items = json.load(f)
    elif args.token and (args.dataset_id or args.task_id):
        print("Fetching items from Apify API...")
        try:
            raw_items = fetch_apify_items(args.token, dataset_id=args.dataset_id, task_id=args.task_id)
        except Exception as e:
            print(f"Error fetching from Apify: {e}", file=sys.stderr)
            return 1
    else:
        print("Tip: Provide either --input-file or place your file at data/imports/twitter.csv.", file=sys.stderr)
        return 1

    print(f"Loaded {len(raw_items)} items from data source.")
    if not raw_items:
        print("No items to process.")
        return 0

    api_client = None
    if args.api:
        key = os.environ.get("GROWTH_API_KEY")
        if not key and args.key_file.exists():
            key = args.key_file.read_text().strip()
        if not key:
            print("Error: GROWTH_API_KEY not found and data/api-key does not exist.", file=sys.stderr)
            return 1
        api_client = GrowthApiClient(args.base, key)

    stats = sync_twitter_items(
        raw_items,
        db_file=args.db_file,
        account_id=args.account_id,
        dry_run=args.dry_run,
        api_client=api_client,
    )
    print(
        f"\n✅ 同步完成！新增推文记录: {stats['synced_posts']} 条，"
        f"写入最新指标快照: {stats['synced_metrics']} 项，"
        f"筛除外部账号上下文: {stats['skipped_external']} 条，"
        f"缺少作者: {stats['skipped_missing_author']} 条，"
        f"缺少推文 ID: {stats['skipped_missing_id']} 条。"
    )
    print("后台「运营数据页面」在刷新后将自动展现最新的执行概况、增长表现与推文窗口指标。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
