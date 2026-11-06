#!/usr/bin/env python3
"""Growth operations notebook API.

Run with:
    python3 growth-ops/server.py
"""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import io
import re
import zipfile
import json
import math
import mimetypes
import os
import secrets
import sqlite3
import subprocess
import sys
import threading
import time
import uuid
import webbrowser
from datetime import date, datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse
import urllib.request


API_PREFIX = "/api/v1"
DEFAULT_PORT = 8787
RESOURCE_NAMES = [
    "platforms",
    "accounts",
    "products",
    "strategies",
    "tasks",
    "actions",
    "contents",
    "metrics",
    "reviews",
    "knowledge",
    "skills",
    "observations",
]
VERSIONED_RESOURCES = {"strategies", "skills"}
RELATION_RESOURCES = {
    "task_id": "tasks",
    "strategy_id": "strategies",
    "action_id": "actions",
    "content_id": "contents",
    "review_id": "reviews",
    "parent_action_id": "actions",
}
METRIC_AVAILABILITY = {"valid", "missing", "unavailable", "not_applicable"}
WRITE_METHODS = {"POST", "PATCH", "DELETE"}
VERIFICATION_STATUSES = {"pending", "verified", "failed", "not_applicable"}
SUCCESS_STATUSES = {"completed", "done", "success"}
INACTIVE_STATUSES = {"archived", "cancelled", "canceled"}
EXTERNAL_ACTION_TYPES = {"publish", "post", "tweet", "reply", "repost", "quote"}
PUBLISH_ACTION_TYPES = {"publish", "post", "tweet"}
REPLY_ACTION_TYPES = {"reply"}
REPORT_METRICS = ("views", "likes", "replies", "bookmarks")
DAILY_GROWTH_METRICS = ("views", "likes", "received_replies", "bookmarks", "net_followers")
DAILY_GROWTH_SOURCE_NAMES = {
    "views": "views",
    "likes": "likes",
    "replies": "received_replies",
    "received_replies": "received_replies",
    "bookmarks": "bookmarks",
    "followers": "net_followers",
    "net_followers": "net_followers",
}
CONTENT_WINDOWS = {"24h": 24, "72h": 72, "7d": 168, "latest": None}
BEIJING = timezone(timedelta(hours=8))
LIBRARY_KINDS = {"document", "asset"}
LIBRARY_STATUSES = {"active", "archived"}
LIBRARY_MAX_ASSET_BYTES = 10 * 1024 * 1024
LIST_TIME_FIELDS = {
    "created_at": "created_at",
    "updated_at": "updated_at",
    "occurred_at": "actions",
    "observed_at": "metrics",
    "due_at": {"tasks", "observations"},
    "review_period": "reviews",
}


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, details: Any | None = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def stable_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def data_dir() -> Path:
    configured = os.environ.get("GROWTH_DATA_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    return Path(__file__).resolve().parent / "data"


def db_path() -> Path:
    return data_dir() / "growth.sqlite3"


def static_dir() -> Path:
    project = Path(__file__).resolve().parent
    override = os.environ.get("GROWTH_WEB_ROOT")
    if override:
        return Path(override).expanduser().resolve()
    exported = project / "web" / "out"
    if os.environ.get("GROWTH_LEGACY_UI") != "1" and (exported / "index.html").is_file():
        return exported
    return project / "static"


def ensure_api_key() -> str:
    configured = os.environ.get("GROWTH_API_KEY")
    if configured:
        return configured
    directory = data_dir()
    directory.mkdir(parents=True, exist_ok=True)
    key_file = directory / "api-key"
    if key_file.exists():
        key_file.chmod(0o600)
        return key_file.read_text(encoding="utf-8").strip()
    token = secrets.token_urlsafe(32)
    key_file.write_text(token + "\n", encoding="utf-8")
    key_file.chmod(0o600)
    return token


def connect() -> sqlite3.Connection:
    directory = data_dir()
    directory.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path(), timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 30000")
    return conn


def init_db() -> None:
    conn = connect()
    try:
        with conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS records (
                    resource TEXT NOT NULL,
                    id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    account_id TEXT,
                    product_id TEXT,
                    status TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    version INTEGER NOT NULL,
                    data TEXT NOT NULL,
                    PRIMARY KEY (resource, id)
                );
                CREATE INDEX IF NOT EXISTS idx_records_resource_status ON records(resource, status);
                CREATE INDEX IF NOT EXISTS idx_records_account ON records(account_id);
                CREATE INDEX IF NOT EXISTS idx_records_product ON records(product_id);
                CREATE TABLE IF NOT EXISTS record_versions (
                    resource TEXT NOT NULL,
                    id TEXT NOT NULL,
                    version INTEGER NOT NULL,
                    title TEXT NOT NULL,
                    account_id TEXT,
                    product_id TEXT,
                    status TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    data TEXT NOT NULL,
                    PRIMARY KEY (resource, id, version)
                );
                CREATE TABLE IF NOT EXISTS idempotency (
                    key TEXT PRIMARY KEY,
                    request_hash TEXT NOT NULL,
                    status INTEGER NOT NULL,
                    response TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS product_library_entries (
                    id TEXT PRIMARY KEY,
                    product_id TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    title TEXT NOT NULL,
                    category TEXT NOT NULL,
                    status TEXT NOT NULL,
                    version INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    body TEXT NOT NULL,
                    filename TEXT,
                    mime_type TEXT,
                    size_bytes INTEGER NOT NULL,
                    sha256 TEXT,
                    source_path TEXT,
                    content BLOB
                );
                CREATE INDEX IF NOT EXISTS idx_product_library_product_status
                    ON product_library_entries(product_id, status, updated_at);
                CREATE TABLE IF NOT EXISTS product_library_versions (
                    entry_id TEXT NOT NULL,
                    product_id TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    title TEXT NOT NULL,
                    category TEXT NOT NULL,
                    status TEXT NOT NULL,
                    version INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    body TEXT NOT NULL,
                    filename TEXT,
                    mime_type TEXT,
                    size_bytes INTEGER NOT NULL,
                    sha256 TEXT,
                    source_path TEXT,
                    content BLOB,
                    PRIMARY KEY (entry_id, version)
                );
                """
            )
            if os.environ.get("GROWTH_SEED", "1") != "0":
                seed(conn)
    finally:
        conn.close()


def seed(conn: sqlite3.Connection) -> None:
    if conn.execute("SELECT 1 FROM records LIMIT 1").fetchone():
        return
    ts = now_iso()
    x_platform = {
        "resource": "platforms",
        "id": "platform-x",
        "title": "X",
        "account_id": None,
        "product_id": None,
        "status": "active",
        "created_at": ts,
        "updated_at": ts,
        "version": 1,
        "data": stable_json(
            {
                "kind": "social_platform",
                "aliases": ["Twitter", "X"],
                "source": "demo seed",
            }
        ),
    }
    account = {
        "resource": "accounts",
        "id": "account-example-x",
        "title": "示例工作室",
        "account_id": None,
        "product_id": None,
        "status": "active",
        "created_at": ts,
        "updated_at": ts,
        "version": 1,
        "data": stable_json(
            {
                "platform_id": "platform-x",
                "handle": "example_studio",
                "display_name": "示例工作室",
                "source": "demo seed",
            }
        ),
    }
    conn.execute(insert_sql(), x_platform)
    conn.execute(insert_sql(), account)


def insert_sql() -> str:
    return """
        INSERT INTO records
        (resource, id, title, account_id, product_id, status, created_at, updated_at, version, data)
        VALUES
        (:resource, :id, :title, :account_id, :product_id, :status, :created_at, :updated_at, :version, :data)
    """


def row_to_record(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "resource": row["resource"],
        "id": row["id"],
        "title": row["title"],
        "account_id": row["account_id"],
        "product_id": row["product_id"],
        "status": row["status"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "version": row["version"],
        "data": json.loads(row["data"]),
    }


def row_to_library_entry(
    row: sqlite3.Row,
    *,
    include_content: bool = False,
    include_export_bytes: bool = False,
) -> dict[str, Any]:
    result = {
        "id": row["id"] if "id" in row.keys() else row["entry_id"],
        "product_id": row["product_id"],
        "kind": row["kind"],
        "title": row["title"],
        "category": row["category"],
        "status": row["status"],
        "version": row["version"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "body": row["body"],
        "filename": row["filename"],
        "mime_type": row["mime_type"],
        "size_bytes": row["size_bytes"],
        "sha256": row["sha256"],
        "source_path": row["source_path"],
    }
    if include_export_bytes and row["content"] is not None:
        result["content_base64"] = base64.b64encode(row["content"]).decode("ascii")
    if include_content:
        result["content"] = row["content"]
    return result


def validate_resource(resource: str) -> None:
    if resource not in RESOURCE_NAMES:
        raise ApiError(404, "not_found", f"Unknown resource: {resource}")


def require_object(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ApiError(400, "invalid_json", "JSON body must be an object")
    return payload


def parse_body(handler: BaseHTTPRequestHandler, *, max_bytes: int = 16 * 1024 * 1024) -> dict[str, Any]:
    try:
        length = int(handler.headers.get("Content-Length", "0") or "0")
    except ValueError as exc:
        raise ApiError(400, "invalid_length", "Content-Length must be an integer") from exc
    if length < 0 or length > max_bytes:
        raise ApiError(413, "payload_too_large", f"JSON request limit is {max_bytes // (1024 * 1024)} MiB")
    raw = handler.rfile.read(length) if length else b"{}"
    def reject_constant(value):
        raise ValueError("Non-finite JSON number: " + value)
    try:
        return require_object(json.loads(raw.decode("utf-8"), parse_constant=reject_constant))
    except (ValueError, UnicodeDecodeError) as exc:
        raise ApiError(400, "invalid_json", "Request body must be valid UTF-8 JSON with finite numbers") from exc


def validate_write_payload(payload: dict[str, Any]) -> None:
    for field in ("title", "status"):
        if field in payload and (not isinstance(payload[field], str) or not payload[field].strip()):
            raise ApiError(400, "invalid_field", f"{field} must be a nonempty string")
    for field in ("id", "account_id", "product_id"):
        if field in payload and payload[field] is not None:
            if not isinstance(payload[field], str) or not payload[field] or "/" in payload[field]:
                raise ApiError(400, "invalid_field", f"{field} must be a nonempty record ID or null")
    if "data" in payload and not isinstance(payload["data"], dict):
        raise ApiError(400, "invalid_data", "data must be an object")


def get_record(conn: sqlite3.Connection, resource: str, item_id: str) -> dict[str, Any]:
    row = conn.execute(
        "SELECT * FROM records WHERE resource = ? AND id = ?", (resource, item_id)
    ).fetchone()
    if not row:
        raise ApiError(404, "not_found", f"{resource}/{item_id} does not exist")
    return row_to_record(row)


def exists_record(conn: sqlite3.Connection, resource: str, item_id: str) -> bool:
    return bool(
        conn.execute(
            "SELECT 1 FROM records WHERE resource = ? AND id = ?", (resource, item_id)
        ).fetchone()
    )


def decode_library_content(payload: dict[str, Any], *, required: bool) -> bytes | None:
    encoded = payload.get("content_base64")
    if encoded is None:
        if required:
            raise ApiError(400, "invalid_library_asset", "asset content_base64 is required")
        return None
    if not isinstance(encoded, str):
        raise ApiError(400, "invalid_library_asset", "content_base64 must be a string")
    try:
        content = base64.b64decode(encoded.encode("ascii"), validate=True)
    except (UnicodeEncodeError, binascii.Error) as exc:
        raise ApiError(400, "invalid_library_asset", "content_base64 must be valid base64") from exc
    if len(content) > LIBRARY_MAX_ASSET_BYTES:
        raise ApiError(413, "payload_too_large", "Library asset limit is 10 MB")
    return content


def safe_library_filename(value: str | None, fallback: str) -> str:
    raw = value or fallback
    name = raw.replace("\\", "/").split("/")[-1].strip()
    name = re.sub(r"[\x00-\x1f\x7f\"]+", "", name)
    name = re.sub(r"\s+", " ", name).strip()
    return name[:120] or "download"


def ascii_attachment_filename(value: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip(".-")
    return safe[:120] or "download"


def normalize_mime_type(value: str | None, fallback: str) -> str:
    if value is None:
        return fallback
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}", value):
        raise ApiError(400, "invalid_library_asset", "mime_type must be a valid media type")
    return value.lower()


def validate_library_text_field(payload: dict[str, Any], field: str, default: str | None = None) -> str:
    value = payload.get(field, default)
    if not isinstance(value, str):
        raise ApiError(400, "invalid_library_entry", f"{field} must be a string")
    if field != "body":
        value = value.strip()
    if field == "title" and not value:
        raise ApiError(400, "invalid_library_entry", "title must be a nonempty string")
    return value


def build_library_entry(
    conn: sqlite3.Connection,
    product_id: str,
    payload: dict[str, Any],
    existing: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if not exists_record(conn, "products", product_id):
        raise ApiError(404, "not_found", "Product does not exist")
    ts = now_iso()
    if existing:
        expected_version = payload.get("version")
        if isinstance(expected_version, bool) or not isinstance(expected_version, int) or expected_version != existing["version"]:
            raise ApiError(409, "version_conflict", "PATCH requires the current library entry version")
        content = decode_library_content(payload, required=False)
        kind = existing["kind"]
        if content is not None and kind != "asset":
            raise ApiError(400, "invalid_library_asset", "Only asset entries can replace file content")
        filename = existing["filename"]
        mime_type = existing["mime_type"]
        size_bytes = existing["size_bytes"]
        sha256 = existing["sha256"]
        if content is not None:
            filename = validate_optional_string(payload, "filename") or filename or "asset"
            guessed_mime = mimetypes.guess_type(filename)[0] or "application/octet-stream"
            mime_type = normalize_mime_type(validate_optional_string(payload, "mime_type"), guessed_mime)
            size_bytes = len(content)
            sha256 = hashlib.sha256(content).hexdigest()
        return {
            **existing,
            "title": validate_library_text_field(payload, "title", existing["title"]) if "title" in payload else existing["title"],
            "category": validate_library_text_field(payload, "category", existing["category"]) if "category" in payload else existing["category"],
            "status": validate_library_status(payload.get("status", existing["status"])),
            "updated_at": ts,
            "version": existing["version"] + 1,
            "body": validate_library_text_field(payload, "body", existing["body"]) if "body" in payload else existing["body"],
            "filename": filename,
            "mime_type": mime_type,
            "size_bytes": size_bytes,
            "sha256": sha256,
            "source_path": validate_optional_string(payload, "source_path") if "source_path" in payload else existing["source_path"],
            "content": content if content is not None else existing.get("content"),
        }
    kind = payload.get("kind", "document")
    if not isinstance(kind, str) or kind not in LIBRARY_KINDS:
        raise ApiError(400, "invalid_library_entry", "kind must be document or asset")
    content = decode_library_content(payload, required=kind == "asset")
    filename = validate_optional_string(payload, "filename")
    mime_type = validate_optional_string(payload, "mime_type")
    if kind == "document":
        filename = filename
        mime_type = normalize_mime_type(mime_type, "text/markdown") if mime_type else None
        size_bytes = 0
        sha256 = None
    else:
        filename = filename or "asset"
        guessed_mime = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        mime_type = normalize_mime_type(mime_type, guessed_mime)
        size_bytes = len(content or b"")
        sha256 = hashlib.sha256(content or b"").hexdigest()
    return {
        "id": str(payload.get("id") or uuid.uuid4()),
        "product_id": product_id,
        "kind": kind,
        "title": validate_library_text_field(payload, "title"),
        "category": validate_library_text_field(payload, "category", "general"),
        "status": validate_library_status(payload.get("status", "active")),
        "version": 1,
        "created_at": ts,
        "updated_at": ts,
        "body": validate_library_text_field(payload, "body", ""),
        "filename": filename,
        "mime_type": mime_type,
        "size_bytes": size_bytes,
        "sha256": sha256,
        "source_path": validate_optional_string(payload, "source_path"),
        "content": content,
    }


def validate_library_status(value: Any) -> str:
    if not isinstance(value, str) or value not in LIBRARY_STATUSES:
        raise ApiError(400, "invalid_library_entry", "status must be active or archived")
    return value


def validate_optional_string(payload: dict[str, Any], field: str) -> str | None:
    value = payload.get(field)
    if value is None:
        return None
    if not isinstance(value, str):
        raise ApiError(400, "invalid_library_entry", f"{field} must be a string or null")
    return value.strip() or None


def insert_library_entry(conn: sqlite3.Connection, entry: dict[str, Any]) -> None:
    try:
        conn.execute(
            """
            INSERT INTO product_library_entries
            (id, product_id, kind, title, category, status, version, created_at, updated_at, body, filename, mime_type, size_bytes, sha256, source_path, content)
            VALUES
            (:id, :product_id, :kind, :title, :category, :status, :version, :created_at, :updated_at, :body, :filename, :mime_type, :size_bytes, :sha256, :source_path, :content)
            """,
            entry,
        )
    except sqlite3.IntegrityError as exc:
        raise ApiError(409, "duplicate_id", "Library entry id already exists") from exc
    save_library_version(conn, entry)


def update_library_entry(conn: sqlite3.Connection, entry: dict[str, Any]) -> None:
    cursor = conn.execute(
        """
        UPDATE product_library_entries
        SET title = ?, category = ?, status = ?, version = ?, updated_at = ?, body = ?, filename = ?, mime_type = ?,
            size_bytes = ?, sha256 = ?, source_path = ?, content = ?
        WHERE id = ? AND product_id = ? AND version = ?
        """,
        (
            entry["title"],
            entry["category"],
            entry["status"],
            entry["version"],
            entry["updated_at"],
            entry["body"],
            entry["filename"],
            entry["mime_type"],
            entry["size_bytes"],
            entry["sha256"],
            entry["source_path"],
            entry["content"],
            entry["id"],
            entry["product_id"],
            entry["version"] - 1,
        ),
    )
    if cursor.rowcount != 1:
        raise ApiError(409, "version_conflict", "Library entry changed before PATCH completed")
    save_library_version(conn, entry)


def save_library_version(conn: sqlite3.Connection, entry: dict[str, Any]) -> None:
    conn.execute(
        """
        INSERT OR REPLACE INTO product_library_versions
        (entry_id, product_id, kind, title, category, status, version, created_at, updated_at, body, filename, mime_type, size_bytes, sha256, source_path, content)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            entry["id"],
            entry["product_id"],
            entry["kind"],
            entry["title"],
            entry["category"],
            entry["status"],
            entry["version"],
            entry["created_at"],
            entry["updated_at"],
            entry["body"],
            entry["filename"],
            entry["mime_type"],
            entry["size_bytes"],
            entry["sha256"],
            entry["source_path"],
            entry["content"],
        ),
    )


def get_library_entry(conn: sqlite3.Connection, product_id: str, entry_id: str, *, include_content: bool = False) -> dict[str, Any]:
    columns = "*" if include_content else (
        "id, product_id, kind, title, category, status, version, created_at, updated_at, body, "
        "filename, mime_type, size_bytes, sha256, source_path, NULL AS content"
    )
    row = conn.execute(
        f"SELECT {columns} FROM product_library_entries WHERE product_id = ? AND id = ?",
        (product_id, entry_id),
    ).fetchone()
    if not row:
        raise ApiError(404, "not_found", "Library entry does not exist for this product")
    return row_to_library_entry(row, include_content=include_content)


def list_library_entries(conn: sqlite3.Connection, product_id: str, query: dict[str, list[str]]) -> dict[str, Any]:
    if not exists_record(conn, "products", product_id):
        raise ApiError(404, "not_found", "Product does not exist")
    clauses = ["product_id = ?"]
    args: list[Any] = [product_id]
    kind = query.get("kind", [None])[0]
    if kind:
        if kind not in LIBRARY_KINDS:
            raise ApiError(400, "invalid_library_entry", "kind filter must be document or asset")
        clauses.append("kind = ?")
        args.append(kind)
    if query.get("category"):
        clauses.append("category = ?")
        args.append(query["category"][0])
    status = query.get("status", ["active"])[0]
    if status and status != "all":
        if status not in LIBRARY_STATUSES:
            raise ApiError(400, "invalid_library_entry", "status filter must be active, archived or all")
        clauses.append("status = ?")
        args.append(status)
    if query.get("q"):
        clauses.append("(title LIKE ? OR category LIKE ? OR body LIKE ? OR filename LIKE ? OR source_path LIKE ?)")
        needle = f"%{query['q'][0]}%"
        args.extend([needle, needle, needle, needle, needle])
    limit, offset = pagination(query)
    where = " AND ".join(clauses)
    rows = conn.execute(
        f"""
        SELECT id, product_id, kind, title, category, status, version, created_at, updated_at, body,
               filename, mime_type, size_bytes, sha256, source_path, NULL AS content
        FROM product_library_entries
        WHERE {where}
        ORDER BY updated_at DESC, created_at DESC, id DESC
        """,
        args,
    ).fetchall()
    items = [row_to_library_entry(row) for row in rows]
    return {"items": items[offset : offset + limit], "total": len(items), "limit": limit, "offset": offset}


TASK_TYPES = {"account_operations", "content_publishing", "asset_creation", "product_preparation", "analysis_review", "strategy_planning", "other"}


def validate_refs(conn: sqlite3.Connection, resource: str, record: dict[str, Any], touched_data_fields: set[str] | None = None) -> None:
    account_id = record.get("account_id")
    product_id = record.get("product_id")
    if account_id and not exists_record(conn, "accounts", account_id):
        raise ApiError(400, "invalid_reference", "account_id must reference an account")
    if product_id and not exists_record(conn, "products", product_id):
        raise ApiError(400, "invalid_reference", "product_id must reference a product")

    data = record.get("data") or {}
    if not isinstance(data, dict):
        raise ApiError(400, "invalid_data", "data must be an object")
    if "tracking_enabled" in data and (touched_data_fields is None or "tracking_enabled" in touched_data_fields):
        if not isinstance(data["tracking_enabled"], bool):
            raise ApiError(400, "invalid_data", "data.tracking_enabled must be a boolean when provided")
    if resource == "tasks" and (touched_data_fields is None or "task_type" in touched_data_fields):
        task_type = data.get("task_type")
        if task_type is not None and (not isinstance(task_type, str) or task_type not in TASK_TYPES):
            raise ApiError(400, "invalid_task_type", "data.task_type must be a supported task type or null")
    for field, target_resource in RELATION_RESOURCES.items():
        value = data.get(field)
        if value:
            if not exists_record(conn, target_resource, str(value)):
                raise ApiError(
                    400,
                    "invalid_reference",
                    f"data.{field} must reference {target_resource}",
                )
            target = get_record(conn, target_resource, str(value))
            validate_reference_scope(field, account_id, product_id, target)
    metric_ids = data.get("metric_ids")
    if metric_ids is not None:
        if not isinstance(metric_ids, list):
            raise ApiError(400, "invalid_reference", "data.metric_ids must be a list")
        for metric_id in metric_ids:
            if not exists_record(conn, "metrics", str(metric_id)):
                raise ApiError(400, "invalid_reference", "data.metric_ids must reference metrics")
            target = get_record(conn, "metrics", str(metric_id))
            validate_reference_scope("metric_ids", account_id, product_id, target)
    if resource == "accounts":
        platform_id = data.get("platform_id")
        if platform_id and not exists_record(conn, "platforms", str(platform_id)):
            raise ApiError(400, "invalid_reference", "data.platform_id must reference platforms")
    if resource == "metrics":
        if not isinstance(data.get("metric_name"), str) or not data["metric_name"].strip():
            raise ApiError(400, "invalid_metric", "metric_name must be a nonempty string")
        if data.get("metric_type") not in ("cumulative", "interval"):
            raise ApiError(400, "invalid_metric", "metric_type must be cumulative or interval")
        if data.get("source") is not None and not isinstance(data["source"], str):
            raise ApiError(400, "invalid_metric", "source must be a string")
        availability = data.get("availability", "valid")
        if not isinstance(availability, str) or availability not in METRIC_AVAILABILITY:
            raise ApiError(400, "invalid_metric", "metric availability is invalid")
        for required in ("metric_name", "metric_type", "observed_at"):
            if not data.get(required):
                raise ApiError(400, "invalid_metric", f"metric data.{required} is required")
        observed_at = str(data["observed_at"])
        if not is_timezone_iso(observed_at):
            raise ApiError(400, "invalid_metric", "metric data.observed_at must be timezone-aware ISO, for example 2026-09-08T09:00:00Z")
        value = data.get("value")
        if availability == "valid":
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
                raise ApiError(400, "invalid_metric", "valid metric data.value must be a finite number")
        elif value is not None:
            raise ApiError(400, "invalid_metric", "non-valid metric data.value must be null")
    validate_reliability_fields(conn, resource, record, touched_data_fields)


def is_timezone_iso(value: str) -> bool:
    return parse_timezone_iso(value) is not None


def parse_timezone_iso(value: str) -> datetime | None:
    try:
        normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        return None
    return parsed


def parse_required_timezone_iso(value: Any, field: str) -> datetime:
    if not isinstance(value, str):
        raise ApiError(400, "invalid_time", f"{field} must be a timezone-aware ISO string")
    parsed = parse_timezone_iso(value)
    if parsed is None:
        raise ApiError(400, "invalid_time", f"{field} must be timezone-aware ISO")
    return parsed.astimezone(timezone.utc)


def parse_optional_timezone_iso(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    parsed = parse_timezone_iso(value)
    return parsed.astimezone(timezone.utc) if parsed else None


def pagination(query: dict[str, list[str]]) -> tuple[int, int]:
    try:
        limit = min(max(int(query.get("limit", ["50"])[0]), 1), 200)
        offset = max(int(query.get("offset", ["0"])[0]), 0)
    except ValueError as exc:
        raise ApiError(400, "invalid_pagination", "limit and offset must be integers") from exc
    return limit, offset


def action_type(record: dict[str, Any]) -> str:
    value = record["data"].get("action_type") or record["data"].get("type") or record["data"].get("kind") or ""
    return str(value).strip().lower()


def is_external_action(record: dict[str, Any]) -> bool:
    return action_type(record) in EXTERNAL_ACTION_TYPES


def needs_action_verification(record: dict[str, Any]) -> bool:
    return is_external_action(record) or record["data"].get("requires_verification") is True


def is_success_status(record: dict[str, Any]) -> bool:
    return str(record.get("status", "")).strip().lower() in SUCCESS_STATUSES


def is_inactive_status(record: dict[str, Any]) -> bool:
    return str(record.get("status", "")).strip().lower() in INACTIVE_STATUSES


def is_tracking_enabled(record: dict[str, Any]) -> bool:
    return record["data"].get("tracking_enabled") is not False


def has_text_data(record: dict[str, Any], field: str) -> bool:
    value = record["data"].get(field)
    return isinstance(value, str) and bool(value.strip())


def validate_reliability_fields(conn: sqlite3.Connection, resource: str, record: dict[str, Any], touched_data_fields: set[str] | None = None) -> None:
    data = record.get("data") or {}
    for field in ("occurred_at", "verified_at", "review_due_at", "due_at", "completed_at"):
        if field in data and data[field] is not None and (touched_data_fields is None or field in touched_data_fields):
            parse_required_timezone_iso(data[field], f"data.{field}")
    if resource == "metrics":
        if "observed_at_precision" in data and data["observed_at_precision"] is not None and (touched_data_fields is None or "observed_at_precision" in touched_data_fields):
            if not isinstance(data["observed_at_precision"], str) or data["observed_at_precision"] not in {"instant", "minute", "day"}:
                raise ApiError(400, "invalid_metric", "metric data.observed_at_precision must be instant, minute or day")
        has_start = data.get("period_start") is not None
        has_end = data.get("period_end") is not None
        period_touched = touched_data_fields is None or bool({"period_start", "period_end"} & touched_data_fields)
        if has_start != has_end and period_touched:
            raise ApiError(400, "invalid_metric_period", "metric data.period_start and data.period_end must be provided together")
        if has_start and period_touched:
            start = parse_required_timezone_iso(data["period_start"], "data.period_start")
            end = parse_required_timezone_iso(data["period_end"], "data.period_end")
            if start >= end:
                raise ApiError(400, "invalid_metric_period", "metric data.period_start must be before data.period_end")
    if resource == "reviews":
        has_start = data.get("period_start") is not None
        has_end = data.get("period_end") is not None
        period_touched = touched_data_fields is None or bool({"period_start", "period_end"} & touched_data_fields)
        if has_start != has_end and period_touched:
            raise ApiError(400, "invalid_review_period", "review data.period_start and data.period_end must be provided together")
        if has_start and period_touched:
            start = parse_required_timezone_iso(data["period_start"], "data.period_start")
            end = parse_required_timezone_iso(data["period_end"], "data.period_end")
            if start > end:
                raise ApiError(400, "invalid_review_period", "review data.period_start must be <= data.period_end")
    strategy_id = data.get("strategy_id")
    strategy_touched = touched_data_fields is None or bool({"strategy_id", "strategy_version"} & touched_data_fields)
    if strategy_id and strategy_touched:
        version = data.get("strategy_version")
        if version is None:
            strategy = get_record(conn, "strategies", str(strategy_id))
            data["strategy_version"] = strategy["version"]
        elif isinstance(version, bool) or not isinstance(version, int) or version < 1:
            raise ApiError(400, "invalid_strategy_version", "data.strategy_version must be an integer >= 1")
        elif not conn.execute(
            "SELECT 1 FROM record_versions WHERE resource = 'strategies' AND id = ? AND version = ?",
            (str(strategy_id), version),
        ).fetchone():
            raise ApiError(400, "invalid_strategy_version", "data.strategy_version must exist in strategy history")
    if resource != "actions":
        return
    verification_touched = touched_data_fields is None or bool({"verification_status", "verified_at", "verification_evidence", "requires_verification", "external_id", "evidence_url", "action_type", "type", "kind"} & touched_data_fields)
    if verification_touched:
        for field in ("external_id", "evidence_url", "verification_evidence"):
            if data.get(field) is not None and not isinstance(data[field], str):
                raise ApiError(400, "invalid_verification", f"data.{field} must be a string or null")
    if "verification_status" in data and data["verification_status"] is not None and verification_touched:
        if not isinstance(data["verification_status"], str) or data["verification_status"] not in VERIFICATION_STATUSES:
            raise ApiError(400, "invalid_verification", "data.verification_status is invalid")
    if "requires_verification" in data and not isinstance(data["requires_verification"], bool) and verification_touched:
        raise ApiError(400, "invalid_verification", "data.requires_verification must be a boolean")
    if data.get("verification_status") == "verified" and verification_touched:
        if not isinstance(data.get("verified_at"), str) or parse_timezone_iso(data["verified_at"]) is None:
            raise ApiError(400, "invalid_verification", "verified actions require timezone-aware data.verified_at")
        evidence = (data.get("verification_evidence") or "").strip()
        if not evidence:
            raise ApiError(400, "invalid_verification", "verified actions require nonempty data.verification_evidence")
        if is_external_action(record) and not (has_text_data(record, "external_id") or has_text_data(record, "evidence_url")):
            raise ApiError(400, "invalid_verification", "verified external actions require data.external_id or data.evidence_url")


def metric_observed_at(record: dict[str, Any]) -> datetime:
    parsed = parse_timezone_iso(str(record["data"].get("observed_at", "")))
    return parsed or datetime.min.replace(tzinfo=timezone.utc)


def list_time_field(resource: str, query: dict[str, list[str]]) -> str:
    field = query.get("time_field", ["created_at"])[0]
    if field not in LIST_TIME_FIELDS:
        raise ApiError(400, "invalid_time_field", "time_field is invalid")
    allowed = LIST_TIME_FIELDS[field]
    if isinstance(allowed, set):
        ok = resource in allowed
    elif allowed in ("created_at", "updated_at"):
        ok = True
    else:
        ok = resource == allowed
    if not ok:
        raise ApiError(400, "invalid_time_field", f"time_field {field} is not available for {resource}")
    return field


def parse_date_only_bound(value: str, field: str) -> datetime | None:
    if len(value) != 10:
        return None
    try:
        parsed = datetime.strptime(value, "%Y-%m-%d")
    except ValueError:
        return None
    if field == "date_to":
        return parsed.replace(hour=23, minute=59, second=59, microsecond=999999, tzinfo=timezone.utc)
    return parsed.replace(tzinfo=timezone.utc)


def parse_query_bound(value: str | None, field: str, allow_date_only: bool) -> datetime | None:
    if not value:
        return None
    if allow_date_only:
        date_only = parse_date_only_bound(value, field)
        if date_only is not None:
            return date_only
    return parse_required_timezone_iso(value, field)


def query_time_bounds(query: dict[str, list[str]], allow_date_only: bool) -> tuple[datetime | None, datetime | None]:
    start_raw = query.get("date_from", [None])[0]
    end_raw = query.get("date_to", [None])[0]
    start = parse_query_bound(start_raw, "date_from", allow_date_only)
    end = parse_query_bound(end_raw, "date_to", allow_date_only)
    if start and end and start > end:
        raise ApiError(400, "invalid_time", "date_from must be <= date_to")
    return start, end


def record_matches_time(record: dict[str, Any], field: str, start: datetime | None, end: datetime | None) -> bool:
    if start is None and end is None:
        return True
    if field in ("created_at", "updated_at"):
        parsed = parse_optional_timezone_iso(record[field])
        if parsed is None:
            return False
        if isinstance(start, datetime) and parsed < start:
            return False
        if isinstance(end, datetime) and parsed > end:
            return False
        return True
    if field == "review_period":
        period_start = parse_optional_timezone_iso(record["data"].get("period_start"))
        period_end = parse_optional_timezone_iso(record["data"].get("period_end"))
        if period_start is None or period_end is None:
            return False
        if start and period_end < start:
            return False
        if end and period_start > end:
            return False
        return True
    source = record[field] if field in ("created_at", "updated_at") else record["data"].get(field)
    parsed = parse_optional_timezone_iso(source)
    if parsed is None:
        return False
    if start and parsed < start:
        return False
    if end and parsed > end:
        return False
    return True


def validate_reference_scope(field: str, account_id: str | None, product_id: str | None, target: dict[str, Any]) -> None:
    target_account_id = target.get("account_id")
    target_product_id = target.get("product_id")
    if target_account_id and not account_id:
        raise ApiError(400, "missing_reference_scope", f"account_id is required when data.{field} references an account-scoped record")
    if target_product_id and not product_id:
        raise ApiError(400, "missing_reference_scope", f"product_id is required when data.{field} references a product-scoped record")
    if account_id and target_account_id and target_account_id != account_id:
        raise ApiError(400, "invalid_reference_scope", f"data.{field} belongs to another account")
    if product_id and target_product_id and target_product_id != product_id:
        raise ApiError(400, "invalid_reference_scope", f"data.{field} belongs to another product")


def build_record(resource: str, payload: dict[str, Any], existing: dict[str, Any] | None = None) -> dict[str, Any]:
    validate_write_payload(payload)
    ts = now_iso()
    if existing:
        data = dict(existing["data"])
        if "data" in payload:
            patch_data = payload["data"]
            if not isinstance(patch_data, dict):
                raise ApiError(400, "invalid_data", "data must be an object")
            if "strategy_id" in patch_data and "strategy_version" not in patch_data and patch_data["strategy_id"] != existing["data"].get("strategy_id"):
                data.pop("strategy_version", None)
            data.update(patch_data)
        result = {
            **existing,
            "title": payload.get("title", existing["title"]),
            "account_id": payload.get("account_id", existing["account_id"]),
            "product_id": payload.get("product_id", existing["product_id"]),
            "status": payload.get("status", existing["status"]),
            "updated_at": ts,
            "version": existing["version"] + 1,
            "data": data,
        }
        if resource == "actions" and existing["data"].get("verification_status") == "verified" and "data" in payload:
            changed_verified_target = any(
                field in patch_data and patch_data[field] != existing["data"].get(field)
                for field in ("external_id", "evidence_url", "content_id")
            )
            old_verified_at = parse_optional_timezone_iso(existing["data"].get("verified_at"))
            new_verified_at = parse_optional_timezone_iso(patch_data.get("verified_at"))
            supplied_fresh_evidence = (
                new_verified_at is not None
                and new_verified_at != old_verified_at
                and isinstance(patch_data.get("verification_evidence"), str)
                and bool(patch_data["verification_evidence"].strip())
            )
            if changed_verified_target and not supplied_fresh_evidence:
                result["data"]["previous_verification"] = {
                    "external_id": existing["data"].get("external_id"),
                    "evidence_url": existing["data"].get("evidence_url"),
                    "verified_at": existing["data"].get("verified_at"),
                    "verification_evidence": existing["data"].get("verification_evidence"),
                }
                result["data"]["verification_status"] = "pending"
                result["data"]["verified_at"] = None
                result["data"]["verification_evidence"] = None
        return result
    data = payload.get("data", {})
    if not isinstance(data, dict):
        raise ApiError(400, "invalid_data", "data must be an object")
    return {
        "resource": resource,
        "id": str(payload.get("id") or uuid.uuid4()),
        "title": str(payload.get("title") or "Untitled"),
        "account_id": payload.get("account_id"),
        "product_id": payload.get("product_id"),
        "status": str(payload.get("status") or "active"),
        "created_at": ts,
        "updated_at": ts,
        "version": 1,
        "data": data,
    }


def save_version(conn: sqlite3.Connection, record: dict[str, Any]) -> None:
    conn.execute(
        """
        INSERT OR REPLACE INTO record_versions
        (resource, id, version, title, account_id, product_id, status, created_at, updated_at, data)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            record["resource"],
            record["id"],
            record["version"],
            record["title"],
            record["account_id"],
            record["product_id"],
            record["status"],
            record["created_at"],
            record["updated_at"],
            stable_json(record["data"]),
        ),
    )


def insert_record(conn: sqlite3.Connection, record: dict[str, Any]) -> None:
    try:
        conn.execute(
            insert_sql(),
            {
                **record,
                "data": stable_json(record["data"]),
            },
        )
    except sqlite3.IntegrityError as exc:
        raise ApiError(409, "duplicate_id", "Record id already exists") from exc
    if record["resource"] in VERSIONED_RESOURCES:
        save_version(conn, record)


def update_record(conn: sqlite3.Connection, record: dict[str, Any]) -> None:
    current_version = record["version"] - 1
    cursor = conn.execute(
        """
        UPDATE records
        SET title = ?, account_id = ?, product_id = ?, status = ?, updated_at = ?, version = ?, data = ?
        WHERE resource = ? AND id = ? AND version = ?
        """,
        (
            record["title"],
            record["account_id"],
            record["product_id"],
            record["status"],
            record["updated_at"],
            record["version"],
            stable_json(record["data"]),
            record["resource"],
            record["id"],
            current_version,
        ),
    )
    if cursor.rowcount != 1:
        raise ApiError(409, "version_conflict", "Record changed before PATCH completed")
    if record["resource"] in VERSIONED_RESOURCES:
        save_version(conn, record)


def json_response(handler: BaseHTTPRequestHandler, status: int, payload: Any) -> None:
    raw = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(raw)))
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("X-Content-Type-Options", "nosniff")
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, Idempotency-Key")
    handler.end_headers()
    handler.wfile.write(raw)


def error_response(handler: BaseHTTPRequestHandler, error: ApiError) -> None:
    body: dict[str, Any] = {"error": {"code": error.code, "message": error.message}}
    if error.details is not None:
        body["error"]["details"] = error.details
    json_response(handler, error.status, body)


BUSINESS_TIME_FIELDS = {
    "tasks": ("due_at", "planned_on"),
    "actions": ("occurred_at", "occurred_on"),
    "contents": ("published_at", "published_on"),
    "metrics": ("observed_at",),
    "reviews": ("period_end", "period_start"),
    "observations": ("due_at",),
}


def business_time_sort_key(record: dict[str, Any]) -> tuple[datetime, str]:
    fields = BUSINESS_TIME_FIELDS.get(record["resource"])
    value = None
    if fields:
        for field in fields:
            raw = record["data"].get(field)
            # Date-only historical records use the workspace's Beijing day.
            if isinstance(raw, str) and len(raw) == 10:
                raw += "T00:00:00+08:00"
            value = parse_optional_timezone_iso(raw)
            if value is not None:
                break
    else:
        value = parse_optional_timezone_iso(record.get("updated_at"))
    return (value or datetime.min.replace(tzinfo=timezone.utc), record["id"])


def list_records(conn: sqlite3.Connection, resource: str, query: dict[str, list[str]]) -> dict[str, Any]:
    clauses = ["resource = ?"]
    args: list[Any] = [resource]
    for field in ("account_id", "product_id", "status"):
        if query.get(field):
            clauses.append(f"{field} = ?")
            args.append(query[field][0])
    if query.get("task_type"):
        task_type = query["task_type"][0]
        if resource != "tasks" or task_type not in TASK_TYPES | {"unclassified"}:
            raise ApiError(400, "invalid_task_type", "task_type filter is only supported for tasks with a valid type")
        if task_type == "unclassified":
            clauses.append("json_extract(data, '$.task_type') IS NULL")
        else:
            clauses.append("json_extract(data, '$.task_type') = ?")
            args.append(task_type)
    if query.get("q"):
        clauses.append("(title LIKE ? OR data LIKE ?)")
        needle = f"%{query['q'][0]}%"
        args.extend([needle, needle])
    limit, offset = pagination(query)
    time_field = list_time_field(resource, query)
    start, end = query_time_bounds(query, time_field in ("created_at", "updated_at"))
    where = " AND ".join(clauses)
    rows = conn.execute(f"SELECT * FROM records WHERE {where} ORDER BY updated_at DESC, created_at DESC", args).fetchall()
    filtered = [row_to_record(row) for row in rows]
    filtered = [record for record in filtered if record_matches_time(record, time_field, start, end)]
    filtered.sort(key=business_time_sort_key, reverse=True)
    return {
        "items": filtered[offset : offset + limit],
        "total": len(filtered),
        "limit": limit,
        "offset": offset,
    }


def dashboard(conn: sqlite3.Connection, query: dict[str, list[str]]) -> dict[str, Any]:
    account_id = query.get("account_id", [None])[0]
    params: list[Any] = []
    account_clause = ""
    if account_id:
        account_clause = " AND account_id = ?"
        params.append(account_id)
    counts: dict[str, int] = {}
    for resource in RESOURCE_NAMES:
        counts[resource] = conn.execute(
            f"SELECT COUNT(*) AS c FROM records WHERE resource = ? AND LOWER(TRIM(status)) NOT IN ('archived', 'cancelled', 'canceled'){account_clause}",
            [resource, *params],
        ).fetchone()["c"]
    all_metric_rows = conn.execute(
        f"""
        SELECT * FROM records
        WHERE resource = 'metrics' AND LOWER(TRIM(status)) NOT IN ('archived', 'cancelled', 'canceled'){account_clause}
        """,
        params,
    ).fetchall()
    latest_by_metric_key: dict[tuple[Any, ...], dict[str, Any]] = {}
    for row in all_metric_rows:
        record = row_to_record(row)
        data = record["data"]
        key = (
            data.get("metric_name"),
            data.get("metric_type"),
            data.get("account_id") or record.get("account_id"),
            data.get("product_id") or record.get("product_id"),
            data.get("action_id"),
            data.get("content_id"),
            data.get("source"),
        )
        current = latest_by_metric_key.get(key)
        if current is None or metric_observed_at(record) > metric_observed_at(current):
            latest_by_metric_key[key] = record
    grouped_metrics = sorted(
        latest_by_metric_key.values(),
        key=metric_observed_at,
        reverse=True,
    )[:20]
    recent_metric_snapshots = sorted(
        [row_to_record(row) for row in all_metric_rows],
        key=metric_observed_at,
        reverse=True,
    )[:20]
    recent_rows = conn.execute(
        f"""
        SELECT * FROM records
        WHERE resource IN ('tasks', 'actions', 'reviews') AND LOWER(TRIM(status)) NOT IN ('archived', 'cancelled', 'canceled'){account_clause}
        ORDER BY updated_at DESC LIMIT 20
        """,
        params,
    ).fetchall()

    # Calculate Executive KPIs and Report Summary
    action_metrics_query = f"""
    WITH ranked_metrics AS (
        SELECT
            json_extract(data, '$.action_id') AS action_id,
            json_extract(data, '$.metric_name') AS metric_name,
            CAST(json_extract(data, '$.value') AS REAL) AS value,
            ROW_NUMBER() OVER (
                PARTITION BY json_extract(data, '$.action_id'), json_extract(data, '$.metric_name')
                ORDER BY json_extract(data, '$.observed_at') DESC
            ) AS rn
        FROM records
        WHERE resource = 'metrics'
          AND LOWER(TRIM(status)) NOT IN ('archived', 'cancelled', 'canceled')
          AND json_extract(data, '$.action_id') IS NOT NULL
          AND EXISTS (
              SELECT 1 FROM records AS linked_action
              WHERE linked_action.resource = 'actions'
                AND linked_action.id = json_extract(records.data, '$.action_id')
                AND LOWER(TRIM(linked_action.status)) NOT IN ('archived', 'cancelled', 'canceled')
          ){account_clause}
    )
    SELECT action_id, metric_name, value
    FROM ranked_metrics
    WHERE rn = 1;
    """
    ranked_rows = conn.execute(action_metrics_query, params).fetchall()
    metrics_by_action: dict[str, dict[str, float]] = {}
    for r in ranked_rows:
        aid = r["action_id"]
        if aid not in metrics_by_action:
            metrics_by_action[aid] = {}
        metrics_by_action[aid][r["metric_name"]] = r["value"] or 0.0

    total_views = int(sum(m.get("views", 0) for m in metrics_by_action.values()))
    total_likes = int(sum(m.get("likes", 0) for m in metrics_by_action.values()))
    total_retweets = int(sum(m.get("retweets", 0) + m.get("reposts", 0) for m in metrics_by_action.values()))
    total_replies = int(sum(m.get("replies", 0) for m in metrics_by_action.values()))
    total_engagements = total_likes + total_retweets + total_replies
    engagement_rate = round((total_engagements / total_views * 100), 1) if total_views > 0 else 0.0

    actions_raw = conn.execute(
        f"SELECT * FROM records WHERE resource = 'actions' AND LOWER(TRIM(status)) NOT IN ('archived', 'cancelled', 'canceled'){account_clause}",
        params,
    ).fetchall()
    actions_records = [row_to_record(r) for r in actions_raw]
    total_actions = len(actions_records)
    posts_count = sum(1 for a in actions_records if a["data"].get("action_type") in ("publish", "post", "tweet"))
    replies_count = sum(1 for a in actions_records if a["data"].get("action_type") in ("reply", "comment"))

    tasks_raw = conn.execute(
        f"SELECT * FROM records WHERE resource = 'tasks' AND LOWER(TRIM(status)) NOT IN ('archived', 'cancelled', 'canceled'){account_clause}",
        params,
    ).fetchall()
    tasks_records = [row_to_record(r) for r in tasks_raw]
    total_tasks = len(tasks_records)
    completed_tasks = sum(1 for t in tasks_records if t["status"] in ("completed", "done", "success"))
    completion_rate = round((completed_tasks / total_tasks * 100), 1) if total_tasks > 0 else 0.0
    pending_tasks_count = sum(1 for t in tasks_records if t["status"] in ("planned", "in_progress"))

    # Top performing actions
    actions_with_metrics = []
    for a in actions_records:
        aid = a["id"]
        m = metrics_by_action.get(aid, {})
        v = int(m.get("views", 0))
        eng = int(m.get("likes", 0) + m.get("retweets", 0) + m.get("reposts", 0) + m.get("replies", 0))
        actions_with_metrics.append({
            "id": a["id"],
            "title": a["title"],
            "status": a["status"],
            "action_type": a["data"].get("action_type") or "other",
            "occurred_at": a["data"].get("occurred_at") or a["created_at"],
            "evidence_url": a["data"].get("evidence_url"),
            "views": v,
            "engagements": eng,
            "likes": int(m.get("likes", 0)),
            "retweets": int(m.get("retweets", 0)),
            "replies": int(m.get("replies", 0)),
        })
    actions_with_metrics.sort(key=lambda x: (x["views"], x["engagements"]), reverse=True)
    top_actions = actions_with_metrics[:4]

    # Upcoming tasks
    upcoming_task_rows = conn.execute(
        f"""
        SELECT * FROM records
        WHERE resource = 'tasks' AND status IN ('planned', 'in_progress'){account_clause}
        ORDER BY json_extract(data, '$.due_at') ASC, updated_at DESC
        LIMIT 5
        """,
        params,
    ).fetchall()
    upcoming_tasks = [row_to_record(row) for row in upcoming_task_rows]

    # Latest Review
    latest_review_row = conn.execute(
        f"""
        SELECT * FROM records
        WHERE resource = 'reviews' AND status != 'archived'{account_clause}
        ORDER BY updated_at DESC
        LIMIT 1
        """,
        params,
    ).fetchone()
    latest_review = row_to_record(latest_review_row) if latest_review_row else None

    # Daily Trends
    from collections import defaultdict
    daily_map: dict[str, dict[str, Any]] = defaultdict(lambda: {"date": "", "posts": 0, "replies": 0, "views": 0, "engagements": 0})
    for a in actions_records:
        dt_str = a["data"].get("occurred_at") or a["created_at"]
        dkey = dt_str[:10]
        daily_map[dkey]["date"] = dkey
        atype = a["data"].get("action_type") or "other"
        if atype in ("publish", "post", "tweet"):
            daily_map[dkey]["posts"] += 1
        elif atype in ("reply", "comment"):
            daily_map[dkey]["replies"] += 1
        m = metrics_by_action.get(a["id"], {})
        daily_map[dkey]["views"] += int(m.get("views", 0))
        daily_map[dkey]["engagements"] += int(m.get("likes", 0) + m.get("retweets", 0) + m.get("replies", 0))
    daily_trends = sorted(daily_map.values(), key=lambda x: x["date"])

    kpis = {
        "total_views": total_views,
        "total_engagements": total_engagements,
        "engagement_rate": engagement_rate,
        "total_actions": total_actions,
        "posts_count": posts_count,
        "replies_count": replies_count,
        "tasks_total": total_tasks,
        "tasks_completed": completed_tasks,
        "completion_rate": completion_rate,
        "pending_tasks_count": pending_tasks_count,
    }

    return {
        "account_id": account_id,
        "counts": counts,
        "latest_metrics": grouped_metrics,
        "recent_metric_snapshots": recent_metric_snapshots,
        "recent_work": [row_to_record(row) for row in recent_rows],
        "kpis": kpis,
        "upcoming_tasks": upcoming_tasks,
        "top_actions": top_actions,
        "latest_review": latest_review,
        "daily_trends": daily_trends,
    }


def account_context(conn: sqlite3.Connection, account_id: str) -> dict[str, Any]:
    if not exists_record(conn, "accounts", account_id):
        raise ApiError(404, "not_found", "Account does not exist")
    account = get_record(conn, "accounts", account_id)
    platform = None
    platform_id = account["data"].get("platform_id")
    if platform_id and exists_record(conn, "platforms", str(platform_id)):
        platform = get_record(conn, "platforms", str(platform_id))
    sections: dict[str, Any] = {"account": account, "platform": platform}
    for resource in ("strategies", "tasks", "actions", "contents", "metrics", "reviews", "knowledge", "skills", "observations"):
        rows = conn.execute(
            """
            SELECT * FROM records
            WHERE resource = ? AND account_id = ? AND status != 'archived'
            ORDER BY updated_at DESC LIMIT 20
            """,
            (resource, account_id),
        ).fetchall()
        sections[resource] = [row_to_record(row) for row in rows]
    product_ids = {
        record["product_id"]
        for resource in ("strategies", "tasks", "actions", "contents", "metrics", "reviews", "observations")
        for record in sections.get(resource, [])
        if record.get("product_id")
    }
    product_rows: list[sqlite3.Row] = []
    if product_ids:
        placeholders = ",".join("?" for _ in product_ids)
        product_rows = conn.execute(
            f"SELECT * FROM records WHERE resource = 'products' AND id IN ({placeholders}) ORDER BY updated_at DESC",
            list(product_ids),
        ).fetchall()
    sections["products"] = [row_to_record(row) for row in product_rows]
    active_strategy = conn.execute(
        "SELECT * FROM records WHERE resource = 'strategies' AND account_id = ? AND status = 'active' ORDER BY updated_at DESC, id LIMIT 1",
        (account_id,),
    ).fetchone()
    sections["current_strategy"] = row_to_record(active_strategy) if active_strategy else None
    sections["limits"] = {"per_section": 20, "note": "Recent account-scoped records; paginate resource endpoints for complete history and query global methods separately."}
    return sections


def same_owner_scope(source: dict[str, Any], target: dict[str, Any]) -> bool:
    source_account = source.get("account_id")
    source_product = source.get("product_id")
    target_account = target.get("account_id")
    target_product = target.get("product_id")
    if source_account and target_account and source_account != target_account:
        return False
    if source_product and target_product and source_product != target_product:
        return False
    if source_account and target_account is None:
        return True
    if source_product and target_product is None:
        return True
    return True


def same_business_scope(source: dict[str, Any], target: dict[str, Any]) -> bool:
    return source.get("account_id") == target.get("account_id") and source.get("product_id") == target.get("product_id")


def records_by_resource(conn: sqlite3.Connection, resource: str) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT * FROM records WHERE resource = ? AND LOWER(TRIM(status)) NOT IN ('archived', 'cancelled', 'canceled') ORDER BY updated_at DESC, created_at DESC",
        (resource,),
    ).fetchall()
    return [row_to_record(row) for row in rows]


def page_collection(items: list[dict[str, Any]], limit: int, offset: int) -> dict[str, Any]:
    return {"items": items[offset : offset + limit], "total": len(items), "limit": limit, "offset": offset}


def review_references_action(review: dict[str, Any], action: dict[str, Any], metrics_by_id: dict[str, dict[str, Any]]) -> bool:
    data = review["data"]
    if data.get("action_id") == action["id"]:
        return same_business_scope(action, review)
    if data.get("content_id") and data.get("content_id") == action["data"].get("content_id"):
        return same_business_scope(action, review)
    metric_ids = data.get("metric_ids") if isinstance(data.get("metric_ids"), list) else []
    for metric_id in metric_ids:
        metric = metrics_by_id.get(str(metric_id))
        if metric and metric["data"].get("action_id") == action["id"] and same_business_scope(action, metric) and same_business_scope(action, review):
            return True
    return False


def is_effective_review(record: dict[str, Any]) -> bool:
    return str(record.get("status", "")).strip().lower() not in {"draft", "planned", "pending", "cancelled", "canceled", "archived"}


def strategy_snapshot_for_action(conn: sqlite3.Connection, action: dict[str, Any]) -> tuple[dict[str, Any] | None, str, dict[str, Any]]:
    strategy_id = action["data"].get("strategy_id")
    if not strategy_id:
        return None, "missing", {"reason": "action has no data.strategy_id"}
    version = action["data"].get("strategy_version")
    if isinstance(version, int) and not isinstance(version, bool):
        row = conn.execute(
            """
            SELECT resource, id, title, account_id, product_id, status, created_at, updated_at, version, data
            FROM record_versions WHERE resource = 'strategies' AND id = ? AND version = ?
            """,
            (str(strategy_id), version),
        ).fetchone()
        if not row:
            return None, "missing", {"strategy_id": strategy_id, "version": version, "reason": "strategy version is missing"}
        snapshot = row_to_record(row)
        if not same_owner_scope(action, snapshot):
            return None, "missing", {"strategy_id": strategy_id, "version": version, "reason": "strategy version belongs to another scope"}
        return snapshot, "exact", {"strategy_id": strategy_id, "version": version}
    if exists_record(conn, "strategies", str(strategy_id)):
        strategy = get_record(conn, "strategies", str(strategy_id))
        if not same_owner_scope(action, strategy):
            return None, "missing", {"strategy_id": strategy_id, "reason": "strategy belongs to another scope"}
        return strategy, "current_unpinned", {"strategy_id": strategy_id, "version": strategy["version"], "reason": "action has no stored data.strategy_version"}
    return None, "missing", {"strategy_id": strategy_id, "reason": "strategy is missing"}


def action_context(conn: sqlite3.Connection, action_id: str, query: dict[str, list[str]]) -> dict[str, Any]:
    limit, offset = pagination(query)
    action = get_record(conn, "actions", action_id)
    task = get_record(conn, "tasks", str(action["data"]["task_id"])) if action["data"].get("task_id") and exists_record(conn, "tasks", str(action["data"]["task_id"])) else None
    content = get_record(conn, "contents", str(action["data"]["content_id"])) if action["data"].get("content_id") and exists_record(conn, "contents", str(action["data"]["content_id"])) else None
    parent_action = get_record(conn, "actions", str(action["data"]["parent_action_id"])) if action["data"].get("parent_action_id") and exists_record(conn, "actions", str(action["data"]["parent_action_id"])) else None
    strategy, strategy_resolution, strategy_resolution_detail = strategy_snapshot_for_action(conn, action)

    all_metrics = records_by_resource(conn, "metrics")
    metrics = [record for record in all_metrics if same_business_scope(action, record) and (record["data"].get("action_id") == action_id or (content and record["data"].get("content_id") == content["id"]))]
    metrics_by_id = {record["id"]: record for record in all_metrics}
    all_reviews = [record for record in records_by_resource(conn, "reviews") if same_business_scope(action, record)]
    all_matching_reviews = [record for record in all_reviews if review_references_action(record, action, metrics_by_id)]
    matching_review_ids = {record["id"] for record in all_matching_reviews}
    observations = [
        record for record in records_by_resource(conn, "observations")
        if same_business_scope(action, record) and (record["data"].get("action_id") == action_id or (content and record["data"].get("content_id") == content["id"]))
    ]
    follow_up_tasks = [
        record for record in records_by_resource(conn, "tasks")
        if same_business_scope(action, record) and str(record["data"].get("review_id") or "") in matching_review_ids
    ]
    follow_up_actions = [
        record for record in records_by_resource(conn, "actions")
        if same_business_scope(action, record) and (record["data"].get("parent_action_id") == action_id or str(record["data"].get("review_id") or "") in matching_review_ids)
    ]
    return {
        "action": action,
        "task": task,
        "strategy": strategy,
        "strategy_resolution": strategy_resolution,
        "strategy_resolution_detail": strategy_resolution_detail,
        "content": content,
        "parent_action": parent_action,
        "collections": {
            "metrics": page_collection(metrics, limit, offset),
            "observations": page_collection(observations, limit, offset),
            "reviews": page_collection(all_matching_reviews, limit, offset),
            "follow_up_tasks": page_collection(follow_up_tasks, limit, offset),
            "follow_up_actions": page_collection(follow_up_actions, limit, offset),
        },
    }


def reconciliation(conn: sqlite3.Connection, query: dict[str, list[str]]) -> dict[str, Any]:
    limit, offset = pagination(query)
    as_of_raw = query.get("as_of", [None])[0]
    as_of = parse_required_timezone_iso(as_of_raw, "as_of") if as_of_raw else datetime.now(timezone.utc)
    account_id = query.get("account_id", [None])[0]
    product_id = query.get("product_id", [None])[0]
    kind_filter = query.get("kind", [None])[0]
    allowed_kinds = {"overdue_task", "missing_evidence", "unverified_action", "overdue_observation", "review_due"}
    if kind_filter and kind_filter not in allowed_kinds:
        raise ApiError(400, "invalid_kind", "kind is invalid")

    def in_query_scope(record: dict[str, Any]) -> bool:
        if account_id and record.get("account_id") != account_id:
            return False
        if product_id and record.get("product_id") != product_id:
            return False
        return True

    def append(items: list[dict[str, Any]], kind: str, resource: str, record: dict[str, Any], reason: str, due_at: str | None = None) -> None:
        items.append({
            "id": f"{kind}:{resource}:{record['id']}",
            "kind": kind,
            "resource": resource,
            "record_id": record["id"],
            "title": record["title"],
            "account_id": record.get("account_id"),
            "product_id": record.get("product_id"),
            "reason": reason,
            "due_at": due_at,
        })

    items: list[dict[str, Any]] = []
    for task in records_by_resource(conn, "tasks"):
        due_at = parse_optional_timezone_iso(task["data"].get("due_at"))
        if is_tracking_enabled(task) and in_query_scope(task) and not is_success_status(task) and due_at and due_at <= as_of:
            append(items, "overdue_task", "tasks", task, "任务已到期但尚未完成", task["data"].get("due_at"))
    for observation in records_by_resource(conn, "observations"):
        due_at = parse_optional_timezone_iso(observation["data"].get("due_at"))
        if is_tracking_enabled(observation) and in_query_scope(observation) and not is_success_status(observation) and due_at and due_at <= as_of:
            append(items, "overdue_observation", "observations", observation, "监测已到期但尚未完成", observation["data"].get("due_at"))

    metrics_by_id = {record["id"]: record for record in records_by_resource(conn, "metrics")}
    effective_reviews = [record for record in records_by_resource(conn, "reviews") if is_effective_review(record)]
    for action in records_by_resource(conn, "actions"):
        if not is_tracking_enabled(action) or not in_query_scope(action):
            continue
        data = action["data"]
        if is_success_status(action) and needs_action_verification(action):
            if is_external_action(action) and not (has_text_data(action, "external_id") or has_text_data(action, "evidence_url")):
                append(items, "missing_evidence", "actions", action, "成功的外部动作缺少 external_id 或 evidence_url")
            if data.get("verification_status") != "verified":
                append(items, "unverified_action", "actions", action, "成功的需核验动作尚未核验")
        review_due = parse_optional_timezone_iso(data.get("review_due_at"))
        if review_due and review_due <= as_of:
            has_review = any(in_query_scope(review) and review_references_action(review, action, metrics_by_id) for review in effective_reviews)
            if not has_review:
                append(items, "review_due", "actions", action, "动作复盘已到期但没有有效复盘", data.get("review_due_at"))

    def reconciliation_sort_key(item: dict[str, Any]) -> tuple[datetime, str, str, str, str]:
        due_at = parse_optional_timezone_iso(item.get("due_at")) or datetime.max.replace(tzinfo=timezone.utc)
        return due_at, item["kind"], item["resource"], item["record_id"], item["id"]

    items.sort(key=reconciliation_sort_key)
    counts = {kind: 0 for kind in sorted(allowed_kinds)}
    for item in items:
        counts[item["kind"]] += 1
    if kind_filter:
        items = [item for item in items if item["kind"] == kind_filter]
    return {
        "items": items[offset : offset + limit],
        "total": len(items),
        "limit": limit,
        "offset": offset,
        "counts": counts,
        "as_of": as_of.isoformat().replace("+00:00", "Z"),
    }


def parse_beijing_date(value: str | None, field: str) -> date | None:
    if not value:
        return None
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise ApiError(400, "invalid_time", f"{field} must be YYYY-MM-DD")
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError as exc:
        raise ApiError(400, "invalid_time", f"{field} must be a valid calendar date") from exc


def beijing_day_from_iso(value: Any) -> date | None:
    parsed = parse_optional_timezone_iso(value)
    return parsed.astimezone(BEIJING).date() if parsed else None


def action_report_day(record: dict[str, Any]) -> date | None:
    data = record["data"]
    day = beijing_day_from_iso(data.get("occurred_at"))
    if day is not None:
        return day
    for field in ("occurred_on", "published_on"):
        value = data.get(field)
        if isinstance(value, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            try:
                return datetime.strptime(value, "%Y-%m-%d").date()
            except ValueError:
                return None
    return None


def report_action_kind(record: dict[str, Any]) -> str:
    kind = action_type(record)
    if kind in PUBLISH_ACTION_TYPES:
        return "publish"
    if kind in REPLY_ACTION_TYPES:
        return "reply"
    return "other"


def action_occurred_value(record: dict[str, Any]) -> str | None:
    value = record["data"].get("occurred_at")
    return value if isinstance(value, str) and value else None


def action_occurred_on_value(record: dict[str, Any]) -> str | None:
    value = record["data"].get("occurred_on") or record["data"].get("published_on")
    return value if isinstance(value, str) and value else None


def publication_state_for_action(action: dict[str, Any], contents_by_id: dict[str, dict[str, Any]]) -> str:
    data = action["data"]
    content_id = data.get("content_id")
    content = contents_by_id.get(str(content_id)) if content_id else None
    state = data.get("publication_state")
    action_state = state.strip().lower() if isinstance(state, str) and state.strip() else None
    if content and same_business_scope(action, content):
        content_state = content["data"].get("publication_state")
        normalized_content_state = content_state.strip().lower() if isinstance(content_state, str) and content_state.strip() else None
        status_state = str(content.get("status") or "").strip().lower() or None
        if "deleted" in {action_state, normalized_content_state, status_state}:
            return "deleted"
        return action_state or normalized_content_state or status_state or "unknown"
    return action_state or "unknown"


def action_dedupe_key(record: dict[str, Any]) -> tuple[str | None, str, str]:
    account_id = record.get("account_id")
    data = record["data"]
    external_id = data.get("external_id")
    if isinstance(external_id, str) and external_id.strip():
        return (account_id, "external_id", external_id.strip())
    content_id = data.get("content_id")
    if isinstance(content_id, str) and content_id.strip():
        return (account_id, "content_id", content_id.strip())
    return (account_id, "record_id", record["id"])


def action_dedupe_sort_key(record: dict[str, Any]) -> tuple[datetime, datetime, str]:
    business_day = action_report_day(record)
    business_time = (
        parse_optional_timezone_iso(record["data"].get("occurred_at"))
        or (datetime.combine(business_day, datetime.min.time(), tzinfo=BEIJING).astimezone(timezone.utc) if business_day else datetime.min.replace(tzinfo=timezone.utc))
    )
    updated_at = parse_optional_timezone_iso(record.get("updated_at")) or datetime.min.replace(tzinfo=timezone.utc)
    return (business_time, updated_at, record["id"])


def query_report_dates(query: dict[str, list[str]]) -> tuple[date | None, date | None]:
    start = parse_beijing_date(query.get("date_from", [None])[0], "date_from")
    end = parse_beijing_date(query.get("date_to", [None])[0], "date_to")
    if start and end and start > end:
        raise ApiError(400, "invalid_time", "date_from must be <= date_to")
    return start, end


def in_report_scope(record: dict[str, Any], account_id: str | None, product_id: str | None) -> bool:
    if account_id and record.get("account_id") != account_id:
        return False
    if product_id and record.get("product_id") != product_id:
        return False
    return True


def in_report_dates(day: date | None, start: date | None, end: date | None) -> bool:
    if day is None:
        return start is None and end is None
    if start and day < start:
        return False
    if end and day > end:
        return False
    return True


def metric_latest_sort_key(record: dict[str, Any]) -> tuple[datetime, datetime, str]:
    observed = metric_observed_at(record)
    updated = parse_optional_timezone_iso(record.get("updated_at")) or datetime.min.replace(tzinfo=timezone.utc)
    return (observed, updated, record["id"])


def format_utc(value: datetime | None) -> str | None:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z") if value else None


def normalize_metric_name(value: Any) -> str:
    return str(value or "").strip().lower()


def metric_snapshot(record: dict[str, Any]) -> dict[str, Any]:
    data = record["data"]
    return {
        "value": data.get("value") if data.get("availability", "valid") == "valid" else None,
        "availability": data.get("availability", "valid"),
        "observed_at": data.get("observed_at"),
        "precision": data.get("observed_at_precision") or data.get("precision") or "instant",
        "metric_id": record["id"],
    }


def metric_value(record: dict[str, Any]) -> int | float | None:
    data = record["data"]
    value = data.get("value")
    if data.get("availability", "valid") != "valid":
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
        return None
    return value


def metric_observation_quality(metric: dict[str, Any], action: dict[str, Any], target_hours: int | None) -> dict[str, Any]:
    observed = metric_observed_at(metric)
    occurred = parse_optional_timezone_iso(action["data"].get("occurred_at"))
    if occurred is None or target_hours is None:
        return {"actual_age_hours": None, "window_quality": "latest"}
    age_hours = (observed - occurred).total_seconds() / 3600
    return {
        "actual_age_hours": round(age_hours, 2),
        "window_quality": "exact" if abs(age_hours - target_hours) <= 0.5 else "outside_window",
    }


def metric_snapshot_for_action(metric: dict[str, Any], action: dict[str, Any], target_hours: int | None = None) -> dict[str, Any]:
    snapshot = metric_snapshot(metric)
    snapshot.update(metric_observation_quality(metric, action, target_hours))
    return snapshot


def latest_report_metrics(
    metrics: list[dict[str, Any]],
    actions_by_id: dict[str, dict[str, Any]],
    content_to_action: dict[str, dict[str, Any]],
) -> tuple[dict[str, dict[str, dict[str, Any]]], datetime | None, int]:
    latest: dict[tuple[str, str], dict[str, Any]] = {}
    latest_observed: datetime | None = None
    raw_count = 0
    for metric in metrics:
        data = metric["data"]
        if data.get("metric_type") != "cumulative":
            continue
        metric_name = normalize_metric_name(data.get("metric_name"))
        if metric_name not in REPORT_METRICS:
            continue
        action_id = data.get("action_id")
        action = actions_by_id.get(str(action_id)) if action_id else None
        content_id = data.get("content_id")
        if action is None and content_id:
            action = content_to_action.get(str(content_id))
        if action is None or not same_business_scope(action, metric):
            continue
        raw_count += 1
        observed = metric_observed_at(metric)
        if latest_observed is None or observed > latest_observed:
            latest_observed = observed
        key = (action["id"], metric_name)
        current = latest.get(key)
        if current is None or metric_latest_sort_key(metric) > metric_latest_sort_key(current):
            latest[key] = metric
    by_action: dict[str, dict[str, dict[str, Any]]] = {}
    for (action_id, metric_name), metric in latest.items():
        action = actions_by_id.get(action_id)
        if action:
            by_action.setdefault(action_id, {})[metric_name] = metric_snapshot_for_action(metric, action)
    return by_action, latest_observed, raw_count


def window_report_metrics(
    metrics: list[dict[str, Any]],
    actions_by_id: dict[str, dict[str, Any]],
    content_to_action: dict[str, dict[str, Any]],
    window: str,
) -> tuple[dict[str, dict[str, dict[str, Any]]], datetime | None, int]:
    if window == "latest":
        return latest_report_metrics(metrics, actions_by_id, content_to_action)
    target_hours = CONTENT_WINDOWS[window]
    if target_hours is None:
        return latest_report_metrics(metrics, actions_by_id, content_to_action)
    tolerance = timedelta(minutes=30)
    selected: dict[tuple[str, str], tuple[float, dict[str, Any]]] = {}
    latest_observed: datetime | None = None
    raw_count = 0
    for metric in metrics:
        data = metric["data"]
        metric_precision = data.get("observed_at_precision") or data.get("precision")
        if metric_precision == "day":
            continue
        if data.get("metric_type") != "cumulative":
            continue
        metric_name = normalize_metric_name(data.get("metric_name"))
        if metric_name not in REPORT_METRICS:
            continue
        action_id = data.get("action_id")
        action = actions_by_id.get(str(action_id)) if action_id else None
        content_id = data.get("content_id")
        if action is None and content_id:
            action = content_to_action.get(str(content_id))
        if action is None or not same_business_scope(action, metric):
            continue
        raw_count += 1
        occurred = parse_optional_timezone_iso(action["data"].get("occurred_at"))
        action_precision = action["data"].get("occurred_at_precision") or action["data"].get("precision")
        if action_precision == "day":
            continue
        if occurred is None:
            continue
        observed = metric_observed_at(metric)
        if latest_observed is None or observed > latest_observed:
            latest_observed = observed
        distance = abs((observed - (occurred + timedelta(hours=target_hours))).total_seconds())
        if distance > tolerance.total_seconds():
            continue
        key = (action["id"], metric_name)
        current = selected.get(key)
        if current is None or distance < current[0] or (distance == current[0] and metric_latest_sort_key(metric) > metric_latest_sort_key(current[1])):
            selected[key] = (distance, metric)
    by_action: dict[str, dict[str, dict[str, Any]]] = {}
    for (action_id, metric_name), (_, metric) in selected.items():
        action = actions_by_id.get(action_id)
        if action:
            by_action.setdefault(action_id, {})[metric_name] = metric_snapshot_for_action(metric, action, target_hours)
    return by_action, latest_observed, raw_count


def daily_metric_coverage(actions: list[dict[str, Any]], metrics_by_action: dict[str, dict[str, dict[str, Any]]], metric_name: str) -> dict[str, Any]:
    total = len(actions)
    covered = 0
    value = 0.0
    for action in actions:
        metric = metrics_by_action.get(action["id"], {}).get(metric_name)
        if metric and metric.get("availability") == "valid" and isinstance(metric.get("value"), (int, float)) and not isinstance(metric.get("value"), bool):
            covered += 1
            value += float(metric["value"])
    return {
        "value": int(value) if covered and value.is_integer() else (value if covered else None),
        "covered": covered,
        "total": total,
    }


def count_raw_report_metrics(
    metrics: list[dict[str, Any]],
    actions: list[dict[str, Any]],
    actions_by_id: dict[str, dict[str, Any]],
    content_to_action: dict[str, dict[str, Any]],
) -> int:
    action_ids = {action["id"] for action in actions}
    total = 0
    for metric in metrics:
        data = metric["data"]
        if data.get("metric_type") != "cumulative" or normalize_metric_name(data.get("metric_name")) not in REPORT_METRICS:
            continue
        action_id = data.get("action_id")
        content_id = data.get("content_id")
        action = actions_by_id.get(str(action_id)) if action_id else None
        if action is None and content_id:
            action = content_to_action.get(str(content_id))
        if action is not None and action["id"] in action_ids:
            total += 1
    return total


def latest_followers_by_day(metrics: list[dict[str, Any]], account_id: str | None, product_id: str | None) -> dict[date, int | float | None]:
    if product_id or not account_id:
        return {}
    latest: dict[date, dict[str, Any]] = {}
    for metric in metrics:
        data = metric["data"]
        if normalize_metric_name(data.get("metric_name")) != "followers":
            continue
        if data.get("metric_type") != "cumulative":
            continue
        if data.get("action_id") or data.get("content_id"):
            continue
        if account_id and metric.get("account_id") != account_id:
            continue
        if metric.get("product_id") is not None:
            continue
        day = beijing_day_from_iso(data.get("observed_at"))
        if day is None:
            continue
        current = latest.get(day)
        if current is None or metric_latest_sort_key(metric) > metric_latest_sort_key(current):
            latest[day] = metric
    result: dict[date, int | float | None] = {}
    for day, metric in latest.items():
        data = metric["data"]
        result[day] = data.get("value") if data.get("availability", "valid") == "valid" else None
    return result


def report_midnight(day: date) -> datetime:
    return datetime.combine(day, datetime.min.time(), tzinfo=BEIJING).astimezone(timezone.utc)


def is_beijing_midnight(value: datetime) -> bool:
    local = value.astimezone(BEIJING)
    return local.hour == 0 and local.minute == 0 and local.second == 0 and local.microsecond == 0


def is_one_beijing_day(start: datetime, end: datetime) -> bool:
    return is_beijing_midnight(start) and is_beijing_midnight(end) and end - start == timedelta(days=1)


def growth_coverage(
    value: int | float | None = None,
    *,
    method: str = "missing",
    scope: str = "missing",
    covered: int = 0,
    total: int = 0,
    period_start: datetime | None = None,
    period_end: datetime | None = None,
    source: str | None = None,
    anomaly: str | None = None,
) -> dict[str, Any]:
    result = {
        "value": value,
        "covered": covered,
        "total": total,
        "method": method,
        "scope": scope,
        "period_start": format_utc(period_start),
        "period_end": format_utc(period_end),
    }
    if source:
        result["source"] = source
    if anomaly:
        result["anomaly"] = anomaly
    return result


def normalize_growth_value(metric_name: str, value: int | float) -> int | float | None:
    if metric_name != "net_followers" and value < 0:
        return None
    return int(value) if isinstance(value, float) and value.is_integer() else value


def daily_growth_report(
    metrics: list[dict[str, Any]],
    account_id: str | None,
    product_id: str | None,
    start: date | None,
    end: date | None,
) -> tuple[dict[date, dict[str, dict[str, Any]]], list[date]]:
    latest_interval: dict[tuple[str | None, str | None, date, str, str | None], dict[str, Any]] = {}
    exact_snapshots: dict[tuple[str | None, str | None, str, str | None, datetime], dict[str, Any]] = {}
    days: set[date] = set()
    for metric in metrics:
        data = metric["data"]
        raw_name = normalize_metric_name(data.get("metric_name"))
        metric_name = DAILY_GROWTH_SOURCE_NAMES.get(raw_name)
        if metric_name is None:
            continue
        if account_id and metric.get("account_id") != account_id:
            continue
        if product_id:
            if metric.get("product_id") != product_id:
                continue
            scope = "product"
        else:
            if metric.get("product_id") is not None:
                continue
            scope = "account"
        if data.get("action_id") or data.get("content_id"):
            continue
        observed_day = beijing_day_from_iso(data.get("observed_at"))
        if observed_day and in_report_dates(observed_day, start, end):
            days.add(observed_day)
        if data.get("metric_type") == "interval":
            period_start = parse_optional_timezone_iso(data.get("period_start") or data.get("interval_start"))
            period_end = parse_optional_timezone_iso(data.get("period_end") or data.get("interval_end"))
            if period_start is None or period_end is None or not is_one_beijing_day(period_start, period_end):
                continue
            day = period_start.astimezone(BEIJING).date()
            if not in_report_dates(day, start, end):
                continue
            days.add(day)
            source = data.get("source") if isinstance(data.get("source"), str) else None
            key = (metric.get("account_id"), metric.get("product_id"), day, metric_name, source)
            current = latest_interval.get(key)
            if current is None or metric_latest_sort_key(metric) > metric_latest_sort_key(current):
                latest_interval[key] = metric
        elif data.get("metric_type") == "cumulative" and (data.get("observed_at_precision") or data.get("precision") or "instant") != "day":
            observed = metric_observed_at(metric)
            if not is_beijing_midnight(observed):
                continue
            source = data.get("source") if isinstance(data.get("source"), str) else None
            key = (metric.get("account_id"), metric.get("product_id"), metric_name, source, observed)
            current = exact_snapshots.get(key)
            if current is None or metric_latest_sort_key(metric) > metric_latest_sort_key(current):
                exact_snapshots[key] = metric

    def metric_to_growth(metric: dict[str, Any], metric_name: str, method: str, scope: str, period_start: datetime, period_end: datetime) -> dict[str, Any]:
        value = metric_value(metric)
        normalized = normalize_growth_value(metric_name, value) if value is not None else None
        data = metric["data"]
        return growth_coverage(
            normalized,
            method=method,
            scope=scope,
            covered=1 if normalized is not None else 0,
            total=1,
            period_start=period_start,
            period_end=period_end,
            source=data.get("source") if isinstance(data.get("source"), str) else None,
            anomaly="negative_delta" if normalized is None and value is not None else None,
        )

    def aggregate_coverages(items: list[dict[str, Any]]) -> dict[str, Any]:
        if not items:
            return growth_coverage()
        values = [item["value"] for item in items if isinstance(item.get("value"), (int, float)) and not isinstance(item.get("value"), bool)]
        total = sum(int(item.get("total") or 0) for item in items)
        covered = sum(int(item.get("covered") or 0) for item in items)
        value = sum(float(item) for item in values) if values else None
        period_starts = [parse_optional_timezone_iso(item.get("period_start")) for item in items if item.get("period_start")]
        period_ends = [parse_optional_timezone_iso(item.get("period_end")) for item in items if item.get("period_end")]
        methods = {item.get("method") for item in items if item.get("method")}
        scopes = {item.get("scope") for item in items if item.get("scope")}
        sources = {item.get("source") for item in items if item.get("source")}
        anomalies = [item.get("anomaly") for item in items if item.get("anomaly")]
        return growth_coverage(
            int(value) if isinstance(value, float) and value.is_integer() else value,
            method=next(iter(methods)) if len(methods) == 1 else "mixed",
            scope=next(iter(scopes)) if len(scopes) == 1 else "mixed",
            covered=covered,
            total=total,
            period_start=min([item for item in period_starts if item], default=None),
            period_end=max([item for item in period_ends if item], default=None),
            source=next(iter(sources)) if len(sources) == 1 else ("multiple" if sources else None),
            anomaly=anomalies[0] if anomalies and covered == 0 else None,
        )

    interval_source_groups: dict[tuple[str | None, str | None, date, str], list[dict[str, Any]]] = {}
    for (candidate_account, candidate_product, day, metric_name, _source), metric in latest_interval.items():
        interval_source_groups.setdefault((candidate_account, candidate_product, day, metric_name), []).append(metric)

    interval_by_entity: dict[tuple[str | None, str | None, date, str], dict[str, Any]] = {}
    result_candidates: dict[tuple[date, str], list[dict[str, Any]]] = {}
    for key, candidates in interval_source_groups.items():
        selected = max(candidates, key=metric_latest_sort_key)
        candidate_account, candidate_product, day, metric_name = key
        data = selected["data"]
        coverage = metric_to_growth(
            selected,
            metric_name,
            "platform_daily",
            "account" if candidate_product is None else "product",
            parse_required_timezone_iso(data.get("period_start") or data.get("interval_start"), "data.period_start"),
            parse_required_timezone_iso(data.get("period_end") or data.get("interval_end"), "data.period_end"),
        )
        interval_by_entity[key] = coverage
        result_candidates.setdefault((day, metric_name), []).append(coverage)

    snapshot_by_entity: dict[tuple[str | None, str | None, date, str], tuple[tuple[datetime, datetime, str], dict[str, Any]]] = {}
    for key, current in exact_snapshots.items():
        metric_name = key[2]
        observed = key[4]
        previous_observed = observed - timedelta(days=1)
        previous = exact_snapshots.get((key[0], key[1], key[2], key[3], previous_observed))
        if previous is None:
            continue
        day = previous_observed.astimezone(BEIJING).date()
        entity_key = (key[0], key[1], day, metric_name)
        if not in_report_dates(day, start, end) or entity_key in interval_by_entity:
            continue
        curr_value = metric_value(current)
        prev_value = metric_value(previous)
        if curr_value is None or prev_value is None:
            continue
        delta = float(curr_value) - float(prev_value)
        normalized = normalize_growth_value(metric_name, delta)
        period_start = previous_observed
        period_end = observed
        coverage = growth_coverage(
            normalized,
            method="snapshot_difference",
            scope="account" if key[1] is None else "product",
            covered=1 if normalized is not None else 0,
            total=1,
            period_start=period_start,
            period_end=period_end,
            source=key[3],
            anomaly="negative_delta" if normalized is None else None,
        )
        current_choice = snapshot_by_entity.get(entity_key)
        sort_key = metric_latest_sort_key(current)
        if current_choice is None or sort_key > current_choice[0]:
            snapshot_by_entity[entity_key] = (sort_key, coverage)
        days.add(day)

    for (_candidate_account, _candidate_product, day, metric_name), (_sort, coverage) in snapshot_by_entity.items():
        result_candidates.setdefault((day, metric_name), []).append(coverage)

    result: dict[date, dict[str, dict[str, Any]]] = {}
    for (day, metric_name), candidates in result_candidates.items():
        result.setdefault(day, {})[metric_name] = aggregate_coverages(candidates)
    return result, sorted(days)


def completed_tasks_by_day(tasks: list[dict[str, Any]], account_id: str | None, product_id: str | None) -> tuple[dict[date, int], int]:
    counts: dict[date, int] = {}
    undated = 0
    for task in tasks:
        if not is_success_status(task) or not in_report_scope(task, account_id, product_id):
            continue
        data = task["data"]
        day = beijing_day_from_iso(data.get("completed_at"))
        if day is None:
            raw_day = data.get("completed_on")
            if isinstance(raw_day, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw_day):
                try:
                    day = datetime.strptime(raw_day, "%Y-%m-%d").date()
                except ValueError:
                    day = None
        if day is None:
            undated += 1
            continue
        counts[day] = counts.get(day, 0) + 1
    return counts, undated


def report_calendar_range(days: list[date], start: date | None, end: date | None) -> tuple[date | None, date | None, bool]:
    if not days and not (start and end):
        return None, None, False
    first = start or min(days)
    last = end or max(days)
    if first > last:
        return None, None, False
    truncated = False
    if (last - first).days > 365:
        first = last - timedelta(days=365)
        truncated = True
    return first, last, truncated


def operations_report(conn: sqlite3.Connection, query: dict[str, list[str]]) -> dict[str, Any]:
    limit, offset = pagination({"limit": query.get("limit", ["10"]), "offset": query.get("offset", ["0"])})
    view = query.get("view", ["execution"])[0]
    if view == "daily":
        view = "execution"
    if view not in {"execution", "growth", "content"}:
        raise ApiError(400, "invalid_view", "view must be execution, growth or content")
    window = query.get("window", ["latest" if view == "content" else "24h"])[0]
    if window not in {"24h", "72h", "7d", "latest"}:
        raise ApiError(400, "invalid_window", "window must be 24h, 72h, 7d or latest")
    type_filter = query.get("type", ["all"])[0]
    if type_filter not in {"all", "publish", "reply"}:
        raise ApiError(400, "invalid_type", "type must be all, publish or reply")
    if view != "content" and type_filter != "all":
        raise ApiError(400, "invalid_type", "type filter is only supported for content view")
    account_id = query.get("account_id", [None])[0]
    product_id = query.get("product_id", [None])[0]
    start, end = query_report_dates(query)
    q = str(query.get("q", [""])[0] or "").strip().lower()

    contents_by_id = {record["id"]: record for record in records_by_resource(conn, "contents")}
    raw_actions = [
        record for record in records_by_resource(conn, "actions")
        if is_success_status(record) and in_report_scope(record, account_id, product_id)
    ]
    selected_by_key: dict[tuple[str | None, str, str], dict[str, Any]] = {}
    for action in raw_actions:
        key = action_dedupe_key(action)
        current = selected_by_key.get(key)
        if current is None or action_dedupe_sort_key(action) > action_dedupe_sort_key(current):
            selected_by_key[key] = action
    all_actions = list(selected_by_key.values())
    all_actions.sort(key=lambda item: (action_dedupe_sort_key(item), item["id"]), reverse=True)
    if q and view != "growth":
        all_actions = [action for action in all_actions if q in action["title"].lower() or q in stable_json(action["data"]).lower()]

    content_actions: list[dict[str, Any]] = []
    other_actions: list[dict[str, Any]] = []
    deleted_action_ids: set[str] = set()
    for action in all_actions:
        kind = report_action_kind(action)
        state = publication_state_for_action(action, contents_by_id)
        if state == "deleted":
            deleted_action_ids.add(action["id"])
        if kind in {"publish", "reply"}:
            content_actions.append(action)
        else:
            other_actions.append(action)

    canonical_content_keys = {action_dedupe_key(action): action for action in content_actions}
    actions_by_id = {action["id"]: action for action in content_actions}
    content_to_action = {
        str(action["data"]["content_id"]): action
        for action in content_actions
        if isinstance(action["data"].get("content_id"), str) and action["data"]["content_id"]
    }
    for action in raw_actions:
        canonical = canonical_content_keys.get(action_dedupe_key(action))
        if canonical is None or report_action_kind(action) not in {"publish", "reply"}:
            continue
        actions_by_id[action["id"]] = canonical
        content_id = action["data"].get("content_id")
        if isinstance(content_id, str) and content_id:
            content_to_action[content_id] = canonical
    scoped_metrics = [
        record for record in records_by_resource(conn, "metrics")
        if in_report_scope(record, account_id, product_id)
    ]
    metrics_by_action, latest_observed, window_metric_count = window_report_metrics(scoped_metrics, actions_by_id, content_to_action, window)
    latest_metrics_by_action, latest_content_observed, _ = latest_report_metrics(scoped_metrics, actions_by_id, content_to_action)
    if latest_content_observed and (latest_observed is None or latest_content_observed > latest_observed):
        latest_observed = latest_content_observed
    task_counts_by_day, undated_completed_tasks = completed_tasks_by_day(records_by_resource(conn, "tasks"), account_id, product_id)
    has_completed_task_dates = bool(task_counts_by_day)
    daily_growth_by_day, growth_days = daily_growth_report(records_by_resource(conn, "metrics"), account_id, product_id, start, end)

    filtered_content_actions = [action for action in content_actions if in_report_dates(action_report_day(action), start, end)]
    filtered_other_actions = [action for action in other_actions if in_report_dates(action_report_day(action), start, end)]
    reported_content_actions = [
        action for action in filtered_content_actions
        if view == "execution" or type_filter == "all" or report_action_kind(action) == type_filter
    ]
    reported_other_actions = filtered_other_actions if view == "execution" else []

    rows_by_day: dict[date, dict[str, Any]] = {}
    for day in (
        {action_report_day(action) for action in reported_content_actions + reported_other_actions if action_report_day(action)}
        | {day for day in task_counts_by_day if in_report_dates(day, start, end)}
        | ({day for day in growth_days if in_report_dates(day, start, end)} if view == "growth" else set())
    ):
        rows_by_day[day] = {"content": [], "other": []}
    for action in reported_content_actions:
        day = action_report_day(action)
        if day is not None:
            rows_by_day.setdefault(day, {"content": [], "other": []})["content"].append(action)
    for action in reported_other_actions:
        day = action_report_day(action)
        if day is not None:
            rows_by_day.setdefault(day, {"content": [], "other": []})["other"].append(action)

    daily_items: list[dict[str, Any]] = []
    for day, grouped in rows_by_day.items():
        day_content = grouped["content"]
        posts = [action for action in day_content if report_action_kind(action) == "publish"]
        replies = [action for action in day_content if report_action_kind(action) == "reply"]
        completed_count = task_counts_by_day.get(day)
        daily_items.append({
            "date": day.isoformat(),
            "posts": len(posts),
            "replies": len(replies),
            "deleted_posts": sum(1 for action in posts if action["id"] in deleted_action_ids),
            "other_actions": len(grouped["other"]),
            "completed_tasks": completed_count if completed_count is not None else (0 if has_completed_task_dates else None),
            "content_count": len(day_content),
        })
    daily_items.sort(key=lambda item: item["date"], reverse=True)

    if view == "growth":
        growth_activity_days = growth_days
        range_start, range_end, chart_truncated = report_calendar_range(growth_activity_days, start, end)
        growth_items: list[dict[str, Any]] = []
        if range_start and range_end:
            cursor = range_start
            while cursor <= range_end:
                growth_items.append({
                    "date": cursor.isoformat(),
                    **{
                        metric: daily_growth_by_day.get(cursor, {}).get(metric) or growth_coverage(
                            period_start=report_midnight(cursor),
                            period_end=report_midnight(cursor + timedelta(days=1)),
                        )
                        for metric in DAILY_GROWTH_METRICS
                    },
                })
                cursor += timedelta(days=1)
        growth_items.sort(key=lambda item: item["date"], reverse=True)
        range_start, range_end, chart_truncated = report_calendar_range(
            [datetime.strptime(item["date"], "%Y-%m-%d").date() for item in growth_items],
            start,
            end,
        )
        return {
            "items": growth_items[offset : offset + limit],
            "total": len(growth_items),
            "limit": limit,
            "offset": offset,
            "as_of": format_utc(latest_observed) or now_iso(),
            "summary": {
                "recorded_posts": sum(item["posts"] for item in daily_items),
                "recorded_replies": sum(item["replies"] for item in daily_items),
                "other_actions": sum(item["other_actions"] for item in daily_items),
                "content_count": sum(item["content_count"] for item in daily_items),
                "raw_metric_count": len([
                    metric for metric in scoped_metrics
                    if metric["data"].get("metric_type") == "interval"
                    and DAILY_GROWTH_SOURCE_NAMES.get(normalize_metric_name(metric["data"].get("metric_name"))) in DAILY_GROWTH_METRICS
                ]),
                "undated_completed_tasks": undated_completed_tasks,
                "scope": {"account_id": account_id, "product_id": product_id},
                "date_range": {"from": start.isoformat() if start else None, "to": end.isoformat() if end else None},
                "metric_rule": "Daily growth uses platform daily intervals or exact consecutive Beijing-midnight cumulative differences. Publication-cohort cumulative content metrics are not converted into daily growth.",
            },
            "chart_data": {
                "growth_trend": sorted(growth_items, key=lambda item: item["date"]),
                "extent": {
                    "from": range_start.isoformat() if range_start else None,
                    "to": range_end.isoformat() if range_end else None,
                    "truncated": chart_truncated,
                },
            },
        }

    content_rows: list[dict[str, Any]] = []
    for action in reported_content_actions:
        kind = report_action_kind(action)
        content_id = action["data"].get("content_id")
        content = contents_by_id.get(str(content_id)) if content_id else None
        metrics = {name: metrics_by_action.get(action["id"], {}).get(name) for name in REPORT_METRICS}
        latest_metrics = {name: latest_metrics_by_action.get(action["id"], {}).get(name) for name in REPORT_METRICS}
        content_rows.append({
            "id": action["id"],
            "title": action["title"],
            "account_id": action.get("account_id"),
            "product_id": action.get("product_id"),
            "action_type": kind,
            "occurred_at": action_occurred_value(action),
            "occurred_on": action_occurred_on_value(action),
            "evidence_url": action["data"].get("evidence_url") if isinstance(action["data"].get("evidence_url"), str) else None,
            "publication_state": publication_state_for_action(action, contents_by_id),
            "metrics": {
                "views": metrics.get("views"),
                "likes": metrics.get("likes"),
                "replies": metrics.get("replies"),
                "bookmarks": metrics.get("bookmarks"),
            },
            "latest_metrics": {
                "views": latest_metrics.get("views"),
                "likes": latest_metrics.get("likes"),
                "replies": latest_metrics.get("replies"),
                "bookmarks": latest_metrics.get("bookmarks"),
            },
            "window_status": "matched" if any(metrics.values()) else ("latest" if window == "latest" else "missing_snapshot"),
            "window": window,
            "window_label": {"24h": "24 小时", "72h": "72 小时", "7d": "7 天", "latest": "最新累计"}[window],
            "window_hours": CONTENT_WINDOWS[window],
            "content_id": str(content_id) if content_id else None,
            "content_title": content["title"] if content else None,
        })

    def content_sort_key(item: dict[str, Any]) -> tuple[date, datetime, str]:
        action = actions_by_id.get(item["id"])
        day = action_report_day(action) if action else None
        occurred = parse_optional_timezone_iso(item.get("occurred_at")) or (
            datetime.combine(day, datetime.min.time(), tzinfo=BEIJING).astimezone(timezone.utc) if day else datetime.min.replace(tzinfo=timezone.utc)
        )
        return (day or date.min, occurred, item["id"])

    if window == "latest":
        content_rows.sort(key=content_sort_key, reverse=True)
    else:
        def content_window_sort_key(item: dict[str, Any]) -> tuple[int, float, date, datetime, str]:
            views = item["metrics"]["views"]
            value = views.get("value") if isinstance(views, dict) else None
            known = isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value))
            day, occurred, item_id = content_sort_key(item)
            return (1 if known else 0, float(value) if known else 0, day, occurred, item_id)
        content_rows.sort(key=content_window_sort_key, reverse=True)

    activity_days = [datetime.strptime(item["date"], "%Y-%m-%d").date() for item in daily_items]
    range_start, range_end, chart_truncated = report_calendar_range(activity_days, start, end)
    daily_count_by_date = {item["date"]: item for item in daily_items}
    daily_activity: list[dict[str, Any]] = []
    if range_start and range_end:
        cursor = range_start
        while cursor <= range_end:
            item = daily_count_by_date.get(cursor.isoformat())
            daily_activity.append({
                "date": cursor.isoformat(),
                "posts": item["posts"] if item else 0,
                "replies": item["replies"] if item else 0,
                "completed_tasks": item["completed_tasks"] if item and item["completed_tasks"] is not None else (0 if has_completed_task_dates else None),
                "other_actions": item["other_actions"] if item else 0,
            })
            cursor += timedelta(days=1)

    top_content = []
    for row in content_rows:
        if row["publication_state"] == "deleted":
            continue
        views = row["metrics"]["views"]
        if not views or views.get("availability") != "valid" or not isinstance(views.get("value"), (int, float)) or isinstance(views.get("value"), bool):
            continue
        top_content.append({
            "id": row["id"],
            "title": row["title"],
            "action_type": row["action_type"],
            "views": views["value"],
            "product_id": row.get("product_id"),
            "window_status": row.get("window_status"),
        })
    top_content.sort(key=lambda item: (float(item["views"]), item["id"]), reverse=True)

    source_items = daily_items if view == "execution" else content_rows
    if view == "content":
        recorded_posts = sum(1 for item in content_rows if item["action_type"] == "publish")
        recorded_replies = sum(1 for item in content_rows if item["action_type"] == "reply")
        deleted_posts = sum(1 for item in content_rows if item["action_type"] == "publish" and item["publication_state"] == "deleted")
        other_action_count = 0
        content_count = len(content_rows)
    else:
        recorded_posts = sum(item["posts"] for item in daily_items)
        recorded_replies = sum(item["replies"] for item in daily_items)
        deleted_posts = sum(item["deleted_posts"] for item in daily_items)
        other_action_count = sum(item["other_actions"] for item in daily_items)
        content_count = sum(item["content_count"] for item in daily_items)
    raw_metric_count = window_metric_count if window != "latest" else count_raw_report_metrics(scoped_metrics, reported_content_actions, actions_by_id, content_to_action)
    response = {
        "items": source_items[offset : offset + limit],
        "total": len(source_items),
        "limit": limit,
        "offset": offset,
        "as_of": format_utc(latest_observed) or now_iso(),
        "summary": {
            "recorded_posts": recorded_posts,
            "recorded_replies": recorded_replies,
            "deleted_posts": deleted_posts,
            "other_actions": other_action_count,
            "content_count": content_count,
            "raw_metric_count": raw_metric_count,
            "undated_completed_tasks": undated_completed_tasks,
            "scope": {"account_id": account_id, "product_id": product_id},
            "date_range": {"from": start.isoformat() if start else None, "to": end.isoformat() if end else None},
            "window": window,
            "window_label": {"24h": "发布后24小时", "72h": "发布后72小时", "7d": "发布后7天", "latest": "最新累计"}[window],
            "window_hours": CONTENT_WINDOWS[window],
            "metric_rule": "Execution view counts recorded actions by business date. Content performance uses the selected cumulative observation window and leaves missing metrics null.",
        },
        "chart_data": {
            "daily_activity": daily_activity,
            "top_content": top_content[:10],
            "window": window,
            "extent": {
                "from": range_start.isoformat() if range_start else None,
                "to": range_end.isoformat() if range_end else None,
                "truncated": chart_truncated,
            },
        },
    }
    return response


def export_library_entries(conn: sqlite3.Connection) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    entries = [
        row_to_library_entry(row, include_export_bytes=True)
        for row in conn.execute(
            """
            SELECT id, product_id, kind, title, category, status, version, created_at, updated_at, body,
                   filename, mime_type, size_bytes, sha256, source_path, content
            FROM product_library_entries
            ORDER BY product_id, created_at, id
            """
        )
    ]
    versions = [
        row_to_library_entry(row, include_export_bytes=True)
        for row in conn.execute(
            """
            SELECT entry_id AS id, product_id, kind, title, category, status, version, created_at, updated_at, body,
                   filename, mime_type, size_bytes, sha256, source_path, content
            FROM product_library_versions
            ORDER BY product_id, entry_id, version
            """
        )
    ]
    return entries, versions


def export_all(conn: sqlite3.Connection) -> dict[str, Any]:
    records = [row_to_record(row) for row in conn.execute("SELECT * FROM records ORDER BY resource, created_at")]
    versions = [
        row_to_record(row)
        for row in conn.execute(
            """
            SELECT resource, id, title, account_id, product_id, status, created_at, updated_at, version, data
            FROM record_versions ORDER BY resource, id, version
            """
        )
    ]
    library_entries, library_versions = export_library_entries(conn)
    return {
        "schema_version": 1,
        "exported_at": now_iso(),
        "resources": RESOURCE_NAMES,
        "records": records,
        "versions": versions,
        "product_library_entries": library_entries,
        "product_library_versions": library_versions,
    }


def restore_all(conn: sqlite3.Connection, payload: dict[str, Any]) -> dict[str, Any]:
    required_record_fields = {
        "resource",
        "id",
        "title",
        "account_id",
        "product_id",
        "status",
        "created_at",
        "updated_at",
        "version",
        "data",
    }

    def normalize_restore_record(value: Any, *, require_versioned: bool = False) -> dict[str, Any]:
        record = require_object(value)
        missing = sorted(required_record_fields - record.keys())
        if missing:
            raise ApiError(400, "invalid_restore", "Restore record is missing required fields", {"missing": missing})
        validate_resource(record["resource"])
        if require_versioned and record["resource"] not in VERSIONED_RESOURCES:
            raise ApiError(400, "invalid_restore", "Version history is allowed only for strategies and skills")
        if not isinstance(record["id"], str) or not record["id"]:
            raise ApiError(400, "invalid_restore", "Restore record id must be a non-empty string")
        if not isinstance(record["title"], str):
            raise ApiError(400, "invalid_restore", "Restore record title must be a string")
        if not isinstance(record["status"], str):
            raise ApiError(400, "invalid_restore", "Restore record status must be a string")
        if not isinstance(record["data"], dict):
            raise ApiError(400, "invalid_restore", "Restore record data must be an object")
        if isinstance(record["version"], bool) or not isinstance(record["version"], int) or record["version"] < 1:
            raise ApiError(400, "invalid_restore", "Restore record version must be an integer >= 1")
        if not isinstance(record["created_at"], str) or not is_timezone_iso(record["created_at"]):
            raise ApiError(400, "invalid_restore", "Restore record created_at must be timezone-aware ISO")
        if not isinstance(record["updated_at"], str) or not is_timezone_iso(record["updated_at"]):
            raise ApiError(400, "invalid_restore", "Restore record updated_at must be timezone-aware ISO")
        if record["account_id"] is not None and not isinstance(record["account_id"], str):
            raise ApiError(400, "invalid_restore", "Restore record account_id must be a string or null")
        if record["product_id"] is not None and not isinstance(record["product_id"], str):
            raise ApiError(400, "invalid_restore", "Restore record product_id must be a string or null")
        return {
            "resource": record["resource"],
            "id": record["id"],
            "title": record["title"],
            "account_id": record["account_id"],
            "product_id": record["product_id"],
            "status": record["status"],
            "created_at": record["created_at"],
            "updated_at": record["updated_at"],
            "version": record["version"],
            "data": record["data"],
        }

    required_library_fields = {
        "id",
        "product_id",
        "kind",
        "title",
        "category",
        "status",
        "version",
        "created_at",
        "updated_at",
        "body",
        "filename",
        "mime_type",
        "size_bytes",
        "sha256",
        "source_path",
    }

    def normalize_restore_library_entry(value: Any) -> dict[str, Any]:
        entry = require_object(value)
        missing = sorted(required_library_fields - entry.keys())
        if missing:
            raise ApiError(400, "invalid_restore", "Library entry is missing required fields", {"missing": missing})
        if not isinstance(entry["id"], str) or not entry["id"]:
            raise ApiError(400, "invalid_restore", "Library entry id must be a non-empty string")
        if not isinstance(entry["product_id"], str) or not entry["product_id"]:
            raise ApiError(400, "invalid_restore", "Library entry product_id must be a non-empty string")
        if entry["kind"] not in LIBRARY_KINDS:
            raise ApiError(400, "invalid_restore", "Library entry kind is invalid")
        for field in ("title", "category", "status", "created_at", "updated_at", "body"):
            if not isinstance(entry[field], str):
                raise ApiError(400, "invalid_restore", f"Library entry {field} must be a string")
        validate_library_status(entry["status"])
        if not is_timezone_iso(entry["created_at"]) or not is_timezone_iso(entry["updated_at"]):
            raise ApiError(400, "invalid_restore", "Library entry timestamps must be timezone-aware ISO")
        if isinstance(entry["version"], bool) or not isinstance(entry["version"], int) or entry["version"] < 1:
            raise ApiError(400, "invalid_restore", "Library entry version must be an integer >= 1")
        for field in ("filename", "mime_type", "sha256", "source_path"):
            if entry[field] is not None and not isinstance(entry[field], str):
                raise ApiError(400, "invalid_restore", f"Library entry {field} must be a string or null")
        if entry["mime_type"] is not None:
            normalize_mime_type(entry["mime_type"], "application/octet-stream")
        if isinstance(entry["size_bytes"], bool) or not isinstance(entry["size_bytes"], int) or entry["size_bytes"] < 0:
            raise ApiError(400, "invalid_restore", "Library entry size_bytes must be an integer >= 0")
        content = decode_library_content(entry, required=False)
        if entry["kind"] == "asset" and content is None:
            raise ApiError(400, "invalid_restore", "Library asset entries must include content_base64")
        if content is not None:
            actual_size = len(content)
            actual_sha = hashlib.sha256(content).hexdigest()
            if entry["size_bytes"] != actual_size or entry["sha256"] != actual_sha:
                raise ApiError(400, "invalid_restore", "Library entry bytes do not match size_bytes or sha256")
        elif entry["size_bytes"] != 0 or entry["sha256"] is not None:
            raise ApiError(400, "invalid_restore", "Library entry without content must have size_bytes=0 and sha256=null")
        return {
            "id": entry["id"],
            "product_id": entry["product_id"],
            "kind": entry["kind"],
            "title": entry["title"],
            "category": entry["category"],
            "status": entry["status"],
            "version": entry["version"],
            "created_at": entry["created_at"],
            "updated_at": entry["updated_at"],
            "body": entry["body"],
            "filename": entry["filename"],
            "mime_type": entry["mime_type"],
            "size_bytes": entry["size_bytes"],
            "sha256": entry["sha256"],
            "source_path": entry["source_path"],
            "content": content,
        }

    if payload.get("schema_version") != 1:
        raise ApiError(400, "invalid_restore", "Restore payload schema_version must be 1")
    records = payload.get("records")
    versions = payload.get("versions", [])
    library_entries = payload.get("product_library_entries", [])
    library_versions = payload.get("product_library_versions", [])
    if not isinstance(records, list) or not isinstance(versions, list) or not isinstance(library_entries, list) or not isinstance(library_versions, list):
        raise ApiError(400, "invalid_restore", "Restore payload must include records and versions arrays")
    normalized_records = [normalize_restore_record(record) for record in records]
    normalized_versions = [normalize_restore_record(version, require_versioned=True) for version in versions]
    normalized_library_entries = [normalize_restore_library_entry(entry) for entry in library_entries]
    normalized_library_versions = [normalize_restore_library_entry(version) for version in library_versions]
    conn.execute("BEGIN IMMEDIATE")
    try:
        if conn.execute("SELECT 1 FROM records LIMIT 1").fetchone() or conn.execute("SELECT 1 FROM product_library_entries LIMIT 1").fetchone():
            conn.rollback()
            raise ApiError(409, "restore_not_empty", "Restore is allowed only into an empty database")
        for normalized in normalized_records:
            conn.execute(insert_sql(), {**normalized, "data": stable_json(normalized["data"])})
        for normalized in normalized_records:
            validate_refs(conn, normalized["resource"], normalized, set())
        for version in normalized_versions:
            version_resource = version["resource"]
            version_id = version["id"]
            target = get_record(conn, version_resource, version_id)
            if version["version"] > int(target["version"]):
                raise ApiError(400, "invalid_restore", "Version history cannot exceed current record version")
            if version["version"] == int(target["version"]):
                target_snapshot = {
                    "resource": target["resource"],
                    "id": target["id"],
                    "title": target["title"],
                    "account_id": target["account_id"],
                    "product_id": target["product_id"],
                    "status": target["status"],
                    "created_at": target["created_at"],
                    "updated_at": target["updated_at"],
                    "version": target["version"],
                    "data": target["data"],
                }
                if version != target_snapshot:
                    raise ApiError(400, "invalid_restore", "Current version history must match current record")
            conn.execute(
                """
                INSERT INTO record_versions
                (resource, id, version, title, account_id, product_id, status, created_at, updated_at, data)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    version_resource,
                    version_id,
                    version["version"],
                    version["title"],
                    version["account_id"],
                    version["product_id"],
                    version["status"],
                    version["created_at"],
                    version["updated_at"],
                    stable_json(version["data"]),
                ),
            )
        current_versions = conn.execute(
            "SELECT resource, id, version FROM records WHERE resource IN ('strategies', 'skills')"
        ).fetchall()
        for current in current_versions:
            restored_rows = conn.execute(
                "SELECT version FROM record_versions WHERE resource = ? AND id = ? ORDER BY version",
                (current["resource"], current["id"]),
            ).fetchall()
            restored_versions = [row["version"] for row in restored_rows]
            expected_versions = list(range(1, int(current["version"]) + 1))
            if restored_versions != expected_versions:
                raise ApiError(400, "invalid_restore", "Version history must match current record version")
        for entry in normalized_library_entries:
            if not exists_record(conn, "products", entry["product_id"]):
                raise ApiError(400, "invalid_reference", "Library entry product_id must reference a product")
            conn.execute(
                """
                INSERT INTO product_library_entries
                (id, product_id, kind, title, category, status, version, created_at, updated_at, body, filename, mime_type, size_bytes, sha256, source_path, content)
                VALUES
                (:id, :product_id, :kind, :title, :category, :status, :version, :created_at, :updated_at, :body, :filename, :mime_type, :size_bytes, :sha256, :source_path, :content)
                """,
                entry,
            )
        for version in normalized_library_versions:
            target = conn.execute(
                "SELECT * FROM product_library_entries WHERE id = ? AND product_id = ?",
                (version["id"], version["product_id"]),
            ).fetchone()
            if not target:
                raise ApiError(404, "not_found", "Library version target does not exist")
            target_snapshot = row_to_library_entry(target, include_content=True)
            if version["version"] > target_snapshot["version"]:
                raise ApiError(400, "invalid_restore", "Library version history cannot exceed current entry version")
            if version["version"] == target_snapshot["version"] and version != target_snapshot:
                raise ApiError(400, "invalid_restore", "Current library version must match current entry")
            conn.execute(
                """
                INSERT INTO product_library_versions
                (entry_id, product_id, kind, title, category, status, version, created_at, updated_at, body, filename, mime_type, size_bytes, sha256, source_path, content)
                VALUES
                (:id, :product_id, :kind, :title, :category, :status, :version, :created_at, :updated_at, :body, :filename, :mime_type, :size_bytes, :sha256, :source_path, :content)
                """,
                version,
            )
        for entry in normalized_library_entries:
            restored_rows = conn.execute(
                "SELECT version FROM product_library_versions WHERE entry_id = ? AND product_id = ? ORDER BY version",
                (entry["id"], entry["product_id"]),
            ).fetchall()
            restored_versions = [row["version"] for row in restored_rows]
            expected_versions = list(range(1, int(entry["version"]) + 1))
            if restored_versions != expected_versions:
                raise ApiError(400, "invalid_restore", "Library version history must match current entry version")
        conn.commit()
    except ApiError:
        conn.rollback()
        raise
    except (KeyError, TypeError, ValueError, sqlite3.IntegrityError) as exc:
        conn.rollback()
        raise ApiError(400, "invalid_restore", "Restore payload is invalid", str(exc)) from exc
    result = {"restored": len(records), "versions": len(versions)}
    if normalized_library_entries or normalized_library_versions:
        result["product_library_entries"] = len(normalized_library_entries)
        result["product_library_versions"] = len(normalized_library_versions)
    return result


def import_twitter_items(conn: sqlite3.Connection, payload: dict[str, Any]) -> dict[str, Any]:
    """Import twitter items from parsed items list or CSV text."""
    import csv
    import io

    raw_items: list[dict[str, Any]] = []
    if "items" in payload and isinstance(payload["items"], list):
        raw_items = payload["items"]
    elif "csv" in payload and isinstance(payload["csv"], str):
        reader = csv.DictReader(io.StringIO(payload["csv"]))
        raw_items = list(reader)
    else:
        raise ApiError(400, "invalid_payload", "Payload must include 'items' array or 'csv' string")

    # Import sync_twitter_items from scripts/sync_x_apify.py
    scripts_dir = str(Path(__file__).resolve().parent / "scripts")
    if scripts_dir not in sys.path:
        sys.path.insert(0, scripts_dir)
    from sync_x_apify import sync_twitter_items

    target_account = payload.get("account_id")
    try:
        stats = sync_twitter_items(raw_items, db_file=data_dir() / "growth.sqlite3", account_id=target_account)
    except ValueError as exc:
        raise ApiError(400, "invalid_twitter_import", str(exc)) from exc
    return {
        "ok": True,
        "actions_created": stats.get("synced_posts", 0),
        "metrics_created": stats.get("synced_metrics", 0),
        "total_processed": len(raw_items),
        **stats,
    }


def meta() -> dict[str, Any]:
    fields = ["id", "title", "account_id", "product_id", "status", "created_at", "updated_at", "version", "data"]
    return {
        "resources": RESOURCE_NAMES,
        "record_fields": fields,
        "filters": ["account_id", "product_id", "q", "status", "time_field", "date_from", "date_to", "limit", "offset"],
        "date_filter_semantics": "date_from/date_to default to created_at and compare parsed UTC instants. created_at/updated_at retain YYYY-MM-DD compatibility as UTC day bounds; business fields require timezone-aware ISO.",
        "time_fields": {
            "all": ["created_at", "updated_at"],
            "actions": ["occurred_at"],
            "metrics": ["observed_at"],
            "tasks": ["due_at"],
            "observations": ["due_at"],
            "reviews": ["review_period"],
        },
        "versioned_resources": sorted(VERSIONED_RESOURCES),
        "relation_fields_in_data": RELATION_RESOURCES,
        "relation_list_fields_in_data": {"metric_ids": "metrics"},
        "metric_availability": sorted(METRIC_AVAILABILITY),
        "metric_data_fields": ["metric_name", "value", "availability", "observed_at", "metric_type", "action_id", "source"],
        "metric_rules": "metric_name, metric_type, and timezone-aware ISO observed_at are required. availability=valid requires finite numeric value; missing/unavailable/not_applicable require value=null.",
        "default_status": "active",
        "seed": "Set GROWTH_SEED=0 to initialize schema without the default X platform and example account.",
        "auth": "Authorization: Bearer <api-key>",
        "idempotency": "Idempotency-Key is required on resource POST requests and recommended for all AI writers.",
        "endpoints": {
            "list": "GET /api/v1/{resource}",
            "detail": "GET /api/v1/{resource}/{id}",
            "create": "POST /api/v1/{resource}",
            "patch": "PATCH /api/v1/{resource}/{id} with version",
            "history": "GET /api/v1/{resource}/{id}/history for strategies and skills",
            "dashboard": "GET /api/v1/dashboard?account_id=",
            "operations_report": "GET /api/v1/reports/operations?account_id=&product_id=&date_from=YYYY-MM-DD&date_to=YYYY-MM-DD&view=execution|growth|content&window=24h|72h|7d|latest&type=all|publish|reply",
            "context": "GET /api/v1/accounts/{id}/context",
            "action_context": "GET /api/v1/actions/{id}/context",
            "product_library": "GET/POST /api/v1/products/{product_id}/library; GET/PATCH /api/v1/products/{product_id}/library/{entry_id}; GET /history and /download",
            "reconciliation": "GET /api/v1/reconciliation?account_id=&product_id=&kind=&as_of=&limit=&offset=; counts ignore kind and summarize all account/product-scoped exception kinds.",
            "export": "GET /api/v1/export",
            "restore": "POST /api/v1/restore into empty database",
        },
    }


def openapi() -> dict[str, Any]:
    server_dir = str(Path(__file__).resolve().parent)
    try:
        if server_dir not in sys.path:
            sys.path.insert(0, server_dir)
        from api_schema import build_openapi

        spec = build_openapi()
        spec.setdefault("paths", {})[f"{API_PREFIX}/reports/operations"] = {
            "get": {
                "operationId": "operations_report",
                "summary": "Read execution, daily growth, and content performance reports",
                "description": "Read-only operations report. execution counts actions by business date, growth uses daily interval metrics or exact Beijing-midnight snapshot differences, and content uses a selected cumulative observation window.",
                "parameters": [
                    {"name": "account_id", "in": "query", "schema": {"type": "string"}},
                    {"name": "product_id", "in": "query", "schema": {"type": "string"}},
                    {"name": "date_from", "in": "query", "schema": {"type": "string", "format": "date"}},
                    {"name": "date_to", "in": "query", "schema": {"type": "string", "format": "date"}},
                    {"name": "view", "in": "query", "schema": {"type": "string", "enum": ["execution", "growth", "content"], "default": "execution"}},
                    {"name": "window", "in": "query", "schema": {"type": "string", "enum": ["24h", "72h", "7d", "latest"], "default": "24h"}},
                    {"name": "type", "in": "query", "schema": {"type": "string", "enum": ["all", "publish", "reply"], "default": "all"}},
                    {"name": "q", "in": "query", "schema": {"type": "string"}},
                    {"name": "limit", "in": "query", "schema": {"type": "integer", "minimum": 1, "maximum": 200, "default": 10}},
                    {"name": "offset", "in": "query", "schema": {"type": "integer", "minimum": 0, "default": 0}},
                ],
                "responses": {
                    "200": {
                        "description": "Success",
                        "content": {"application/json": {"schema": {"type": "object", "additionalProperties": True}}},
                    }
                },
            }
        }
        return spec
    except ImportError:
        pass
    paths: dict[str, Any] = {
        "/health": {"get": {"security": [], "summary": "Health check"}},
        f"{API_PREFIX}/meta": {"get": {"summary": "API contract"}},
        f"{API_PREFIX}/openapi.json": {"get": {"summary": "Compact OpenAPI description"}},
        f"{API_PREFIX}/dashboard": {"get": {"summary": "Dashboard summary"}},
        f"{API_PREFIX}/reports/operations": {"get": {"summary": "Operational activity and content performance report"}},
        f"{API_PREFIX}/export": {"get": {"summary": "Export all data"}},
        f"{API_PREFIX}/restore": {"post": {"summary": "Restore export into an empty database"}},
    }
    for resource in RESOURCE_NAMES:
        paths[f"{API_PREFIX}/{resource}"] = {
            "get": {"summary": f"List {resource}"},
            "post": {"summary": f"Create {resource}", "parameters": [{"name": "Idempotency-Key", "in": "header"}]},
        }
        paths[f"{API_PREFIX}/{resource}/{{id}}"] = {
            "get": {"summary": f"Read one {resource}"},
            "patch": {"summary": f"Patch one {resource}; body.version must match current version"},
        }
    return {
        "openapi": "3.1.0",
        "info": {"title": "Growth Operations API", "version": "1.0.0"},
        "servers": [{"url": API_PREFIX}],
        "components": {
            "securitySchemes": {"bearerAuth": {"type": "http", "scheme": "bearer"}},
            "schemas": {"Record": {"type": "object", "additionalProperties": True}},
        },
        "security": [{"bearerAuth": []}],
        "paths": paths,
    }


def skill_download(record: dict[str, Any]) -> tuple[str, bytes]:
    data = record["data"]
    slug = str(data.get("slug") or record["id"])
    slug = re.sub(r"[^a-z0-9-]+", "-", slug.lower()).strip("-")[:64] or "shared-skill"
    files = data.get("files")
    if files is None:
        body = data.get("body")
        if not isinstance(body, str) or not body.strip():
            raise ApiError(400, "empty_skill", "Skill has no downloadable content")
        if not body.startswith("---\n"):
            body = f"---\nname: {slug}\ndescription: {json.dumps(record['title'], ensure_ascii=False)}\n---\n\n" + body
        files = [{"path": "SKILL.md", "content": body}]
    if not isinstance(files, list) or not files or len(files) > 100:
        raise ApiError(400, "invalid_skill_package", "Skill package files must be a nonempty list of at most 100 files")
    entries = {}; seen = set(); total = 0
    for file in files:
        if not isinstance(file, dict):
            raise ApiError(400, "invalid_skill_package", "Invalid package file")
        path, content = file.get("path"), file.get("content")
        if (not isinstance(path, str) or not path or "\\" in path or ":" in path
                or any(part in ("", ".", "..") for part in path.split("/"))
                or any(ord(ch) < 32 for ch in path) or not isinstance(content, str)
                or path.casefold() in seen):
            raise ApiError(400, "invalid_skill_package", "Package paths must be unique safe relative file paths")
        seen.add(path.casefold()); encoded = content.encode("utf-8"); total += len(encoded)
        if total > 10 * 1024 * 1024:
            raise ApiError(400, "invalid_skill_package", "Skill package exceeds 10 MB")
        entries[path] = encoded
    if not entries.get("SKILL.md", b"").strip():
        raise ApiError(400, "invalid_skill_package", "Package must include SKILL.md")
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for path, content in sorted(entries.items()):
            archive.writestr(f"{slug}/{path}", content)
    return f"{slug}-v{record['version']}.zip", output.getvalue()


class GrowthHandler(BaseHTTPRequestHandler):
    server_version = "GrowthOps/1.0"

    def do_GET(self) -> None:
        self.handle_request()

    def do_POST(self) -> None:
        self.handle_request()

    def do_PATCH(self) -> None:
        self.handle_request()

    def do_PUT(self) -> None:
        error_response(self, ApiError(405, "method_not_allowed", "PUT is not implemented"))

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, Idempotency-Key")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, fmt: str, *args: Any) -> None:
        if os.environ.get("GROWTH_LOG_REQUESTS"):
            super().log_message(fmt, *args)

    def handle_request(self) -> None:
        try:
            if self.command in WRITE_METHODS:
                self.reject_cross_origin_write()
            parsed = urlparse(self.path)
            if parsed.path == "/health":
                if self.command != "GET":
                    raise ApiError(405, "method_not_allowed", "Health accepts GET only")
                json_response(self, 200, {"ok": True})
                return
            if parsed.path.startswith(API_PREFIX):
                self.require_auth()
                self.handle_api(parsed.path, parse_qs(parsed.query))
                return
            if self.command != "GET":
                raise ApiError(405, "method_not_allowed", "Only GET is supported for static files")
            self.handle_static(parsed.path)
        except ApiError as exc:
            error_response(self, exc)
        except Exception as exc:  # pragma: no cover - converts unexpected failures to JSON
            import traceback
            traceback.print_exc()
            error_response(self, ApiError(500, "internal_error", f"Unexpected server error: {exc}"))

    def require_auth(self) -> None:
        expected = getattr(self.server, "api_key", None)
        supplied = self.headers.get("Authorization", "")
        if not expected or supplied != f"Bearer {expected}":
            raise ApiError(401, "unauthorized", "Missing or invalid bearer token")

    def reject_cross_origin_write(self) -> None:
        origin = self.headers.get("Origin")
        if not origin:
            return
        allowed = {
            f"http://{self.headers.get('Host')}",
            f"https://{self.headers.get('Host')}",
            "https://x.com",
            "https://twitter.com",
        }
        configured = os.environ.get("GROWTH_ALLOWED_ORIGINS", "")
        allowed.update(item.strip() for item in configured.split(",") if item.strip())
        if origin not in allowed:
            raise ApiError(403, "cross_origin_write_rejected", "Cross-origin writes are rejected")

    def handle_api(self, path: str, query: dict[str, list[str]]) -> None:
        tail = path[len(API_PREFIX) :].strip("/")
        parts = [unquote(part) for part in tail.split("/") if part]
        conn = connect()
        try:
            read_endpoint = (
                not parts
                or parts in (["meta"], ["openapi.json"], ["dashboard"], ["export"], ["reconciliation"], ["reports", "operations"])
                or (len(parts) == 3 and parts[0] == "accounts" and parts[2] == "context")
                or (len(parts) == 3 and parts[0] == "actions" and parts[2] == "context")
            )
            if read_endpoint and self.command != "GET":
                raise ApiError(405, "method_not_allowed", "This endpoint accepts GET only")
            if parts == ["restore"] and self.command != "POST":
                raise ApiError(405, "method_not_allowed", "Restore accepts POST only")
            if parts == ["import", "twitter"] and self.command != "POST":
                raise ApiError(405, "method_not_allowed", "Import accepts POST only")
            if not parts:
                json_response(self, 200, meta())
                return
            if parts == ["meta"]:
                json_response(self, 200, meta())
                return
            if parts == ["openapi.json"]:
                json_response(self, 200, openapi())
                return
            if parts == ["dashboard"]:
                json_response(self, 200, dashboard(conn, query))
                return
            if parts == ["reconciliation"]:
                json_response(self, 200, reconciliation(conn, query))
                return
            if parts == ["reports", "operations"]:
                json_response(self, 200, operations_report(conn, query))
                return
            if parts == ["export"]:
                json_response(self, 200, export_all(conn))
                return
            if parts == ["restore"] and self.command == "POST":
                json_response(self, 200, restore_all(conn, parse_body(self, max_bytes=128 * 1024 * 1024)))
                return
            if parts == ["import", "twitter"] and self.command == "POST":
                json_response(self, 200, import_twitter_items(conn, parse_body(self, max_bytes=32 * 1024 * 1024)))
                return
            if len(parts) == 3 and parts[0] == "accounts" and parts[2] == "context":
                json_response(self, 200, account_context(conn, parts[1]))
                return
            if len(parts) == 3 and parts[0] == "actions" and parts[2] == "context":
                json_response(self, 200, action_context(conn, parts[1], query))
                return
            if len(parts) >= 3 and parts[0] == "products" and parts[2] == "library":
                self.handle_product_library(conn, parts, query)
                return
            if len(parts) == 3 and parts[0] == "skills" and parts[2] == "download":
                if self.command != "GET":
                    raise ApiError(405, "method_not_allowed", "Skill download accepts GET only")
                filename, payload = skill_download(get_record(conn, "skills", parts[1]))
                self.send_response(200)
                self.send_header("Content-Type", "application/zip")
                self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
                self.send_header("Content-Length", str(len(payload)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.end_headers()
                self.wfile.write(payload)
                return
            self.handle_resource(conn, parts, query)
        finally:
            conn.close()

    def handle_product_library(self, conn: sqlite3.Connection, parts: list[str], query: dict[str, list[str]]) -> None:
        product_id = parts[1]
        if len(parts) == 3 and self.command == "GET":
            json_response(self, 200, list_library_entries(conn, product_id, query))
            return
        if len(parts) == 3 and self.command == "POST":
            self.handle_library_create(conn, product_id)
            return
        if len(parts) == 4 and self.command == "GET":
            json_response(self, 200, {"item": get_library_entry(conn, product_id, parts[3])})
            return
        if len(parts) == 4 and self.command == "PATCH":
            self.handle_library_patch(conn, product_id, parts[3])
            return
        if len(parts) == 5 and parts[4] == "history" and self.command == "GET":
            get_library_entry(conn, product_id, parts[3])
            rows = conn.execute(
                """
                SELECT entry_id AS id, product_id, kind, title, category, status, version, created_at, updated_at,
                       body, filename, mime_type, size_bytes, sha256, source_path, NULL AS content
                FROM product_library_versions
                WHERE product_id = ? AND entry_id = ?
                ORDER BY version
                """,
                (product_id, parts[3]),
            ).fetchall()
            json_response(self, 200, {"items": [row_to_library_entry(row) for row in rows]})
            return
        if len(parts) == 5 and parts[4] == "download" and self.command == "GET":
            entry = get_library_entry(conn, product_id, parts[3], include_content=True)
            if entry["kind"] == "asset":
                payload = entry.get("content") or b""
                filename = safe_library_filename(entry.get("filename"), entry["title"])
                mime_type = entry.get("mime_type") or mimetypes.guess_type(filename)[0] or "application/octet-stream"
            else:
                payload = entry["body"].encode("utf-8")
                filename = safe_library_filename(entry.get("filename"), f"{entry['title']}.md")
                mime_type = entry.get("mime_type") or "text/markdown; charset=utf-8"
            self.send_response(200)
            self.send_header("Content-Type", mime_type)
            self.send_header("Content-Disposition", f'attachment; filename="{ascii_attachment_filename(filename)}"')
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(payload)
            return
        raise ApiError(404, "not_found", "Endpoint not found")

    def handle_library_create(self, conn: sqlite3.Connection, product_id: str) -> None:
        payload = parse_body(self)
        idem_key = self.headers.get("Idempotency-Key")
        if not idem_key:
            raise ApiError(400, "idempotency_key_required", "Idempotency-Key is required for library POST")
        request_hash = hashlib.sha256(
            stable_json({"method": self.command, "path": f"/products/{product_id}/library", "body": payload}).encode("utf-8")
        ).hexdigest()
        conn.execute("BEGIN IMMEDIATE")
        try:
            existing = conn.execute("SELECT * FROM idempotency WHERE key = ?", (idem_key,)).fetchone()
            if existing:
                if existing["request_hash"] != request_hash:
                    conn.rollback()
                    raise ApiError(409, "idempotency_conflict", "Idempotency-Key was used with a different request")
                conn.commit()
                json_response(self, existing["status"], json.loads(existing["response"]))
                return
            entry = build_library_entry(conn, product_id, payload)
            insert_library_entry(conn, entry)
            response = {"item": {k: v for k, v in entry.items() if k != "content"}}
            conn.execute(
                "INSERT INTO idempotency (key, request_hash, status, response, created_at) VALUES (?, ?, ?, ?, ?)",
                (idem_key, request_hash, 201, stable_json(response), now_iso()),
            )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        json_response(self, 201, response)

    def handle_library_patch(self, conn: sqlite3.Connection, product_id: str, entry_id: str) -> None:
        payload = parse_body(self)
        conn.execute("BEGIN IMMEDIATE")
        try:
            current = get_library_entry(conn, product_id, entry_id, include_content=True)
            entry = build_library_entry(conn, product_id, payload, current)
            update_library_entry(conn, entry)
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        json_response(self, 200, {"item": {k: v for k, v in entry.items() if k != "content"}})

    def handle_resource(self, conn: sqlite3.Connection, parts: list[str], query: dict[str, list[str]]) -> None:
        resource = parts[0]
        validate_resource(resource)
        if len(parts) == 1 and self.command == "GET":
            json_response(self, 200, list_records(conn, resource, query))
            return
        if len(parts) == 1 and self.command == "POST":
            self.handle_create(conn, resource)
            return
        if len(parts) == 2 and self.command == "GET":
            json_response(self, 200, {"item": get_record(conn, resource, parts[1])})
            return
        if len(parts) == 2 and self.command == "PATCH":
            self.handle_patch(conn, resource, parts[1])
            return
        if len(parts) == 3 and parts[2] == "history" and self.command == "GET":
            if resource not in VERSIONED_RESOURCES:
                raise ApiError(404, "not_found", "History is available only for strategies and skills")
            rows = conn.execute(
                """
                SELECT resource, id, title, account_id, product_id, status, created_at, updated_at, version, data
                FROM record_versions WHERE resource = ? AND id = ? ORDER BY version
                """,
                (resource, parts[1]),
            ).fetchall()
            json_response(self, 200, {"items": [row_to_record(row) for row in rows]})
            return
        raise ApiError(404, "not_found", "Endpoint not found")

    def handle_create(self, conn: sqlite3.Connection, resource: str) -> None:
        payload = parse_body(self)
        idem_key = self.headers.get("Idempotency-Key")
        if not idem_key:
            raise ApiError(400, "idempotency_key_required", "Idempotency-Key is required for resource POST")
        request_hash = hashlib.sha256(
            stable_json({"method": self.command, "resource": resource, "body": payload}).encode("utf-8")
        ).hexdigest()
        conn.execute("BEGIN IMMEDIATE")
        try:
            existing = conn.execute("SELECT * FROM idempotency WHERE key = ?", (idem_key,)).fetchone()
            if existing:
                if existing["request_hash"] != request_hash:
                    conn.rollback()
                    raise ApiError(409, "idempotency_conflict", "Idempotency-Key was used with a different request")
                conn.commit()
                json_response(self, existing["status"], json.loads(existing["response"]))
                return
            record = build_record(resource, payload)
            validate_refs(conn, resource, record)
            insert_record(conn, record)
            response = {"item": record}
            conn.execute(
                "INSERT INTO idempotency (key, request_hash, status, response, created_at) VALUES (?, ?, ?, ?, ?)",
                (idem_key, request_hash, 201, stable_json(response), now_iso()),
            )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        json_response(self, 201, response)

    def handle_patch(self, conn: sqlite3.Connection, resource: str, item_id: str) -> None:
        payload = parse_body(self)
        conn.execute("BEGIN IMMEDIATE")
        try:
            current = get_record(conn, resource, item_id)
            expected_version = payload.get("version")
            if isinstance(expected_version, bool) or not isinstance(expected_version, int) or expected_version != current["version"]:
                conn.rollback()
                raise ApiError(409, "version_conflict", "PATCH requires the current record version")
            record = build_record(resource, payload, current)
            patch_data = payload.get("data")
            touched_data_fields = {
                field for field, value in patch_data.items()
                if value != current["data"].get(field)
            } if isinstance(patch_data, dict) else set()
            validate_refs(conn, resource, record, touched_data_fields)
            update_record(conn, record)
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        json_response(self, 200, {"item": record})

    def proxy_to_dev(self, target_port: int, path: str) -> bool:
        url = f"http://127.0.0.1:{target_port}{path}"
        if getattr(self, "path", None) and "?" in self.path:
            url += "?" + self.path.split("?", 1)[1]
        req_headers = {k: v for k, v in self.headers.items() if k.lower() not in ("host", "content-length")}
        req = urllib.request.Request(url, headers=req_headers)
        try:
            with urllib.request.urlopen(req, timeout=6.0) as resp:
                self.send_response(resp.status)
                for header, val in resp.getheaders():
                    if header.lower() not in ("transfer-encoding", "content-length", "connection"):
                        self.send_header(header, val)
                content = resp.read()
                self.send_header("Content-Length", str(len(content)))
                self.end_headers()
                self.wfile.write(content)
                return True
        except Exception:
            return False

    def handle_static(self, path: str) -> None:
        dev_proxy = os.environ.get("GROWTH_DEV_PROXY")
        if dev_proxy and dev_proxy.isdigit():
            if self.proxy_to_dev(int(dev_proxy), path):
                return
        base = static_dir().resolve()
        rel = unquote(path).lstrip("/") or "index.html"
        candidate = (base / rel).resolve()
        if base not in candidate.parents and candidate != base:
            raise ApiError(403, "forbidden", "Path traversal is not allowed")
        if candidate.is_dir():
            candidate = candidate / "index.html"
        if not candidate.is_file() and not Path(rel).suffix:
            route_index = base / rel / "index.html"
            candidate = route_index if route_index.is_file() else base / "index.html"
        if not candidate.is_file():
            raise ApiError(404, "not_found", "Static asset does not exist")
        raw = candidate.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(candidate.name)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


def make_server(host: str, port: int) -> ThreadingHTTPServer:
    init_db()
    server = ThreadingHTTPServer((host, port), GrowthHandler)
    server.api_key = ensure_api_key()  # type: ignore[attr-defined]
    return server


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Growth operations API server")
    parser.add_argument("--host", default=os.environ.get("GROWTH_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("GROWTH_PORT", str(DEFAULT_PORT))))
    parser.add_argument("--no-seed", action="store_true", help="Create schema without default platform/account seed")
    parser.add_argument("--open", action="store_true", default=os.environ.get("GROWTH_AUTO_OPEN") == "1", help="Automatically open browser and login")
    args = parser.parse_args(argv)
    if args.no_seed:
        os.environ["GROWTH_SEED"] = "0"
    server = make_server(args.host, args.port)
    print(f"Growth Ops API listening on http://{args.host}:{args.port}", file=sys.stderr)
    if os.environ.get("GROWTH_API_KEY"):
        print("API key loaded from GROWTH_API_KEY.", file=sys.stderr)
    else:
        print(f"API key loaded from {data_dir() / 'api-key'}.", file=sys.stderr)
    if args.open:
        key = getattr(server, "api_key", "")
        def _open() -> None:
            time.sleep(0.4)
            url = f"http://{args.host}:{args.port}/?key={key}"
            try:
                webbrowser.open(url)
            except Exception:
                pass
            if sys.platform == "darwin":
                try:
                    subprocess.run(["pbcopy"], input=key.encode("utf-8"), check=False)
                except Exception:
                    pass
        threading.Thread(target=_open, daemon=True).start()
        print(f"Opening browser at http://{args.host}:{args.port} ...", file=sys.stderr)
        if sys.platform == "darwin":
            print("API key copied to clipboard.", file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        return 0
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
