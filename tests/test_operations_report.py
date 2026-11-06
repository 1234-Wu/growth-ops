import http.client
import importlib.util
import json
import os
import tempfile
import threading
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = ROOT / "server.py"
spec = importlib.util.spec_from_file_location("growth_ops_server", SERVER_PATH)
server_module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(server_module)


class OperationsReportCase(unittest.TestCase):
    def setUp(self):
        self.post_counter = 0
        self.tmp = tempfile.TemporaryDirectory()
        self.old_data_dir = os.environ.get("GROWTH_DATA_DIR")
        self.old_key = os.environ.get("GROWTH_API_KEY")
        self.old_seed = os.environ.get("GROWTH_SEED")
        os.environ["GROWTH_DATA_DIR"] = self.tmp.name
        os.environ["GROWTH_API_KEY"] = "test-key"
        os.environ.pop("GROWTH_SEED", None)
        self.server = server_module.make_server("127.0.0.1", 0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        if self.old_data_dir is None:
            os.environ.pop("GROWTH_DATA_DIR", None)
        else:
            os.environ["GROWTH_DATA_DIR"] = self.old_data_dir
        if self.old_key is None:
            os.environ.pop("GROWTH_API_KEY", None)
        else:
            os.environ["GROWTH_API_KEY"] = self.old_key
        if self.old_seed is None:
            os.environ.pop("GROWTH_SEED", None)
        else:
            os.environ["GROWTH_SEED"] = self.old_seed
        self.tmp.cleanup()

    def request(self, method, path, body=None, token="test-key", headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        payload = None if body is None else json.dumps(body).encode("utf-8")
        req_headers = {"Content-Type": "application/json"}
        if token is not None:
            req_headers["Authorization"] = f"Bearer {token}"
        if headers:
            req_headers.update(headers)
        if method == "POST" and path.startswith("/api/v1/") and path != "/api/v1/restore" and "Idempotency-Key" not in req_headers:
            self.post_counter += 1
            req_headers["Idempotency-Key"] = f"auto-{self.post_counter}"
        conn.request(method, path, payload, req_headers)
        res = conn.getresponse()
        raw = res.read()
        conn.close()
        data = json.loads(raw.decode("utf-8")) if raw else None
        return res.status, data

    def account_id(self):
        status, body = self.request("GET", "/api/v1/accounts")
        self.assertEqual(status, 200)
        return body["items"][0]["id"]

    def create_account(self, title):
        status, body = self.request("POST", "/api/v1/accounts", {"title": title})
        self.assertEqual(status, 201)
        return body["item"]["id"]

    def create_product(self, title):
        status, body = self.request("POST", "/api/v1/products", {"title": title})
        self.assertEqual(status, 201)
        return body["item"]["id"]

    def create_content_action(self, account_id, product_id, title, action_type, occurred_at=None, occurred_on=None, external_id=None, publication_state="published", extra=None):
        status, content = self.request(
            "POST",
            "/api/v1/contents",
            {
                "title": title,
                "account_id": account_id,
                "product_id": product_id,
                "status": publication_state,
                "data": {"publication_state": publication_state, "published_on": occurred_on},
            },
        )
        self.assertEqual(status, 201)
        data = {
            "action_type": action_type,
            "content_id": content["item"]["id"],
            "external_id": external_id,
            "publication_state": publication_state,
            "occurred_on": occurred_on,
            "evidence_url": f"https://x.example/status/{external_id}" if external_id else None,
        }
        if occurred_at:
            data["occurred_at"] = occurred_at
        if extra:
            data.update(extra)
        status, action = self.request(
            "POST",
            "/api/v1/actions",
            {"title": title, "account_id": account_id, "product_id": product_id, "status": "completed", "data": data},
        )
        self.assertEqual(status, 201)
        return action["item"], content["item"]

    def create_metric(self, account_id, name, value, observed_at, product_id=None, action_id=None, content_id=None, availability="valid", metric_type="cumulative", precision="day", extra=None):
        data = {
            "metric_name": name,
            "metric_type": metric_type,
            "value": value,
            "availability": availability,
            "observed_at": observed_at,
            "observed_at_precision": precision,
            "source": "test",
            "action_id": action_id,
            "content_id": content_id,
        }
        if extra:
            data.update(extra)
        status, body = self.request(
            "POST",
            "/api/v1/metrics",
            {
                "title": f"{name} snapshot",
                "account_id": account_id,
                "product_id": product_id,
                "status": "completed",
                "data": data,
            },
        )
        self.assertEqual(status, 201)
        return body["item"]

    def seed_report_fixture(self):
        account_id = self.account_id()
        product_id = self.create_product("示例产品 A")
        publish, publish_content = self.create_content_action(
            account_id,
            product_id,
            "2026-09-08 发布 示例产品 A",
            "publish",
            "2026-09-08T16:24:00+08:00",
            "2026-09-08",
            "tweet-1",
        )
        reply, reply_content = self.create_content_action(
            account_id,
            product_id,
            "2026-09-08 回复用户",
            "reply",
            None,
            "2026-09-08",
            "reply-1",
        )
        duplicate, _ = self.create_content_action(
            account_id,
            product_id,
            "Duplicate reply should not count",
            "reply",
            "2026-09-08T20:00:00+08:00",
            "2026-09-08",
            "reply-1",
        )
        deleted, deleted_content = self.create_content_action(
            account_id,
            product_id,
            "2026-09-02 错误版本已删除",
            "publish",
            "2026-09-02T11:24:00+08:00",
            "2026-09-02",
            "deleted-1",
            "deleted",
        )
        self.assertNotEqual(reply["id"], duplicate["id"])
        self.create_metric(account_id, "views", 5, "2026-09-08T23:00:00+08:00", product_id, publish["id"], publish_content["id"])
        self.create_metric(account_id, "views", 13, "2026-09-09T00:00:00+08:00", product_id, publish["id"], publish_content["id"])
        self.create_metric(account_id, "views", 42, "2026-09-09T00:00:00+08:00", product_id, reply["id"], reply_content["id"])
        self.create_metric(account_id, "likes", None, "2026-09-09T00:00:00+08:00", product_id, reply["id"], reply_content["id"], "missing")
        self.create_metric(account_id, "views", 999, "2026-09-09T00:00:00+08:00", product_id, deleted["id"], deleted_content["id"])
        self.create_metric(account_id, "posts", 36, "2026-09-09T00:00:00+08:00")
        self.create_metric(account_id, "followers", 7, "2026-09-09T00:00:00+08:00")
        return account_id, product_id

    def test_execution_report_counts_actions_without_content_metric_growth(self):
        account_id, product_id = self.seed_report_fixture()
        status, task = self.request(
            "POST",
            "/api/v1/tasks",
            {
                "title": "完成复盘",
                "account_id": account_id,
                "product_id": product_id,
                "status": "completed",
                "data": {"completed_at": "2026-09-08T21:00:00+08:00"},
            },
        )
        self.assertEqual(status, 201)
        status, report = self.request(
            "GET",
            f"/api/v1/reports/operations?account_id={account_id}&product_id={product_id}&date_from=2026-09-08&date_to=2026-09-09",
        )
        self.assertEqual(status, 200)
        self.assertEqual(report["total"], 1)
        day = report["items"][0]
        self.assertEqual(day["date"], "2026-09-08")
        self.assertEqual(day["posts"], 1)
        self.assertEqual(day["replies"], 1)
        self.assertEqual(day["completed_tasks"], 1)
        self.assertEqual(day["content_count"], 2)
        self.assertNotIn("views", day)
        self.assertEqual(report["summary"]["raw_metric_count"], 0)
        self.assertEqual(report["chart_data"]["daily_activity"], [
            {"date": "2026-09-08", "posts": 1, "replies": 1, "completed_tasks": 1, "other_actions": 0},
            {"date": "2026-09-09", "posts": 0, "replies": 0, "completed_tasks": 0, "other_actions": 0},
        ])

    def test_deleted_posts_are_counted_but_excluded_from_content_performance(self):
        account_id, product_id = self.seed_report_fixture()
        status, report = self.request(
            "GET",
            f"/api/v1/reports/operations?account_id={account_id}&product_id={product_id}&date_from=2026-09-02&date_to=2026-09-02",
        )
        self.assertEqual(status, 200)
        day = report["items"][0]
        self.assertEqual(day["posts"], 1)
        self.assertEqual(day["deleted_posts"], 1)
        self.assertEqual(report["chart_data"]["top_content"], [])

    def test_content_view_filters_type_and_defaults_to_ten_rows(self):
        account_id, product_id = self.seed_report_fixture()
        for index in range(11):
            action, content = self.create_content_action(
                account_id,
                product_id,
                f"Extra publish {index}",
                "publish",
                f"2026-09-{10 + index:02d}T09:00:00+08:00",
                f"2026-09-{10 + index:02d}",
                f"extra-{index}",
            )
            self.create_metric(account_id, "views", index, f"2026-09-{10 + index:02d}T10:00:00+08:00", product_id, action["id"], content["id"])
        status, report = self.request("GET", f"/api/v1/reports/operations?account_id={account_id}&product_id={product_id}&view=content&type=publish")
        self.assertEqual(status, 200)
        self.assertEqual(report["limit"], 10)
        self.assertEqual(len(report["items"]), 10)
        self.assertTrue(all(item["action_type"] == "publish" for item in report["items"]))
        self.assertEqual(report["items"][0]["occurred_on"], "2026-09-20")
        status, second = self.request("GET", f"/api/v1/reports/operations?account_id={account_id}&product_id={product_id}&view=content&type=publish&limit=10&offset=10")
        self.assertEqual(status, 200)
        self.assertGreater(second["total"], 10)
        self.assertGreaterEqual(len(second["items"]), 1)

    def test_content_fixed_window_requires_precise_matching_snapshot(self):
        account_id, product_id = self.seed_report_fixture()
        action, content = self.create_content_action(
            account_id,
            product_id,
            "Precise 24h post",
            "publish",
            "2026-09-10T09:00:00+08:00",
            "2026-09-10",
            "precise-24h",
        )
        self.create_metric(
            account_id,
            "views",
            88,
            "2026-09-11T09:20:00+08:00",
            product_id,
            action["id"],
            content["id"],
            precision="minute",
        )
        status, report = self.request("GET", f"/api/v1/reports/operations?account_id={account_id}&product_id={product_id}&view=content&window=24h&type=publish")
        self.assertEqual(status, 200)
        first = report["items"][0]
        self.assertEqual(first["id"], action["id"])
        self.assertEqual(first["metrics"]["views"]["value"], 88)
        self.assertEqual(first["metrics"]["views"]["window_quality"], "exact")
        self.assertEqual(first["window_status"], "matched")
        historical = next(item for item in report["items"] if item["title"] == "2026-09-08 发布 示例产品 A")
        self.assertIsNone(historical["metrics"]["views"])
        self.assertEqual(historical["window_status"], "missing_snapshot")

    def test_content_fixed_window_rejects_day_precision_publication_and_metric_inputs(self):
        account_id = self.account_id()
        product_id = self.create_product("示例产品 B")
        action, content = self.create_content_action(
            account_id,
            product_id,
            "Date precision post",
            "publish",
            "2026-09-10T09:00:00+08:00",
            "2026-09-10",
            "date-precision",
            extra={"occurred_at_precision": "day"},
        )
        self.create_metric(
            account_id,
            "views",
            88,
            "2026-09-11T09:00:00+08:00",
            product_id,
            action["id"],
            content["id"],
            precision="minute",
        )
        precise_action, precise_content = self.create_content_action(
            account_id,
            product_id,
            "Day precision metric",
            "publish",
            "2026-09-12T09:00:00+08:00",
            "2026-09-12",
            "day-metric",
        )
        self.create_metric(
            account_id,
            "views",
            77,
            "2026-09-13T09:00:00+08:00",
            product_id,
            precise_action["id"],
            precise_content["id"],
            precision="day",
        )
        status, report = self.request("GET", f"/api/v1/reports/operations?account_id={account_id}&product_id={product_id}&view=content&window=24h&type=publish")
        self.assertEqual(status, 200)
        by_title = {item["title"]: item for item in report["items"]}
        self.assertIsNone(by_title["Date precision post"]["metrics"]["views"])
        self.assertIsNone(by_title["Day precision metric"]["metrics"]["views"])

    def test_growth_report_uses_daily_intervals_and_strict_midnight_diffs(self):
        account_id, _ = self.seed_report_fixture()
        self.create_metric(
            account_id,
            "views",
            9,
            "2026-09-09T00:05:00+08:00",
            metric_type="interval",
            precision="minute",
            extra={"period_start": "2026-09-08T00:00:00+08:00", "period_end": "2026-09-09T00:00:00+08:00"},
        )
        self.create_metric(account_id, "likes", 20, "2026-09-08T00:00:00+08:00", precision="minute")
        self.create_metric(account_id, "likes", 24, "2026-09-09T00:00:00+08:00", precision="minute")
        self.create_metric(account_id, "bookmarks", 5, "2026-09-08T00:00:00+08:00", precision="minute")
        self.create_metric(account_id, "bookmarks", 3, "2026-09-09T00:00:00+08:00", precision="minute")
        status, report = self.request(
            "GET",
            f"/api/v1/reports/operations?account_id={account_id}&view=growth&date_from=2026-09-08&date_to=2026-09-09",
        )
        self.assertEqual(status, 200)
        self.assertEqual([item["date"] for item in report["items"]], ["2026-09-09", "2026-09-08"])
        sep8 = report["items"][1]
        self.assertEqual(sep8["views"]["value"], 9)
        self.assertEqual(sep8["views"]["method"], "platform_daily")
        self.assertEqual(sep8["likes"]["value"], 4)
        self.assertEqual(sep8["likes"]["method"], "snapshot_difference")
        self.assertIsNone(sep8["bookmarks"]["value"])
        self.assertEqual(sep8["bookmarks"]["anomaly"], "negative_delta")
        self.assertEqual(report["chart_data"]["growth_trend"][0]["date"], "2026-09-08")
        self.assertIsNone(report["items"][0]["views"]["value"])

    def test_growth_report_aggregates_accounts_without_overlapping_sources(self):
        account_id = self.account_id()
        second_account_id = self.create_account("Second account")
        for source, value, observed in [
            ("source-a", 10, "2026-09-09T00:05:00+08:00"),
            ("source-b", 11, "2026-09-09T00:06:00+08:00"),
        ]:
            self.create_metric(
                account_id,
                "views",
                value,
                observed,
                metric_type="interval",
                precision="minute",
                extra={"period_start": "2026-09-08T00:00:00+08:00", "period_end": "2026-09-09T00:00:00+08:00", "source": source},
            )
        self.create_metric(
            second_account_id,
            "views",
            3,
            "2026-09-09T00:03:00+08:00",
            metric_type="interval",
            precision="minute",
            extra={"period_start": "2026-09-08T00:00:00+08:00", "period_end": "2026-09-09T00:00:00+08:00", "source": "source-a"},
        )
        self.create_metric(account_id, "likes", 20, "2026-09-08T00:00:00+08:00", precision="minute", extra={"source": "source-a"})
        self.create_metric(account_id, "likes", 24, "2026-09-09T00:00:00+08:00", precision="minute", extra={"source": "source-a"})
        self.create_metric(second_account_id, "likes", 5, "2026-09-08T00:00:00+08:00", precision="minute", extra={"source": "source-a"})
        self.create_metric(second_account_id, "likes", 8, "2026-09-09T00:00:00+08:00", precision="minute", extra={"source": "source-a"})
        self.create_metric(account_id, "bookmarks", 9, "2026-09-08T00:00:00+08:00", precision="day")
        self.create_metric(account_id, "bookmarks", 12, "2026-09-09T00:00:00+08:00", precision="day")

        status, report = self.request("GET", "/api/v1/reports/operations?view=growth&date_from=2026-09-08&date_to=2026-09-08")
        self.assertEqual(status, 200)
        day = report["items"][0]
        self.assertEqual(day["views"]["value"], 14)
        self.assertEqual(day["views"]["covered"], 2)
        self.assertEqual(day["views"]["total"], 2)
        self.assertEqual(day["views"]["source"], "multiple")
        self.assertEqual(day["likes"]["value"], 7)
        self.assertEqual(day["likes"]["covered"], 2)
        self.assertEqual(day["likes"]["method"], "snapshot_difference")
        self.assertIsNone(day["bookmarks"]["value"])
        self.assertEqual(day["bookmarks"]["method"], "missing")

    def test_contract_is_advertised_and_rejects_invalid_query_shape(self):
        status, meta = self.request("GET", "/api/v1/meta")
        self.assertEqual(status, 200)
        self.assertIn("operations_report", meta["endpoints"])
        status, spec = self.request("GET", "/api/v1/openapi.json")
        self.assertEqual(status, 200)
        self.assertIn("/api/v1/reports/operations", spec["paths"])
        status, invalid = self.request("GET", "/api/v1/reports/operations?date_from=2026-09-09T00:00:00Z")
        self.assertEqual(status, 400)
        self.assertEqual(invalid["error"]["code"], "invalid_time")
        status, invalid_type = self.request("GET", "/api/v1/reports/operations?view=daily&type=reply")
        self.assertEqual(status, 400)
        self.assertEqual(invalid_type["error"]["code"], "invalid_type")
        status, invalid_window = self.request("GET", "/api/v1/reports/operations?view=content&window=next_day")
        self.assertEqual(status, 400)
        self.assertEqual(invalid_window["error"]["code"], "invalid_window")
        status, invalid_precision = self.request(
            "POST",
            "/api/v1/metrics",
            {
                "title": "bad precision",
                "account_id": self.account_id(),
                "status": "completed",
                "data": {
                    "metric_name": "views",
                    "metric_type": "cumulative",
                    "value": 1,
                    "observed_at": "2026-09-09T00:00:00+08:00",
                    "observed_at_precision": [],
                },
            },
        )
        self.assertEqual(status, 400)
        self.assertEqual(invalid_precision["error"]["code"], "invalid_metric")


if __name__ == "__main__":
    unittest.main()
