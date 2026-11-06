import http.client
import io
import zipfile
import importlib.util
import json
import os
import tempfile
import threading
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = ROOT / "server.py"
spec = importlib.util.spec_from_file_location("growth_ops_server_reliability", SERVER_PATH)
server_module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(server_module)


class ReliabilityCase(unittest.TestCase):
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

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        payload = None if body is None else json.dumps(body).encode("utf-8")
        req_headers = {"Content-Type": "application/json", "Authorization": "Bearer test-key"}
        if headers:
            req_headers.update(headers)
        if method == "POST" and path.startswith("/api/v1/") and path != "/api/v1/restore" and "Idempotency-Key" not in req_headers:
            self.post_counter += 1
            req_headers["Idempotency-Key"] = f"reliability-{self.post_counter}"
        conn.request(method, path, payload, req_headers)
        res = conn.getresponse()
        raw = res.read()
        conn.close()
        return res.status, json.loads(raw.decode("utf-8")) if raw else None

    def test_tasks_sort_by_business_time_before_pagination(self):
        cases = [
            ("latest", {"due_at": "2026-09-09T19:00:00+08:00"}),
            ("same-day-earlier", {"due_at": "2026-09-09T10:00:00Z"}),
            ("date-only", {"planned_on": "2026-09-09"}),
            ("older-imported-last", {"due_at": "2026-09-08T23:59:00+08:00"}),
            ("missing", {}),
        ]
        for title, data in cases:
            status, _ = self.request("POST", "/api/v1/tasks", {"title": title, "data": data})
            self.assertEqual(status, 201)
        titles = []
        for offset in (0, 2, 4):
            status, page = self.request("GET", f"/api/v1/tasks?limit=2&offset={offset}")
            self.assertEqual(status, 200)
            self.assertEqual(page["total"], 5)
            titles.extend(item["title"] for item in page["items"])
        self.assertEqual(titles, [title for title, _ in cases])

    def test_task_type_validation_and_combined_filter(self):
        for name, kind, status_value in [("reply", "account_operations", "pending"), ("published", "content_publishing", "completed"), ("reply-done", "account_operations", "completed"), ("legacy", None, "pending")]:
            status, _ = self.request("POST", "/api/v1/tasks", {"title": name, "status": status_value, "data": {"task_type": kind}})
            self.assertEqual(status, 201)
        status, result = self.request("GET", "/api/v1/tasks?task_type=account_operations&status=pending&limit=1")
        self.assertEqual(status, 200)
        self.assertEqual(result["total"], 1)
        self.assertEqual(result["items"][0]["title"], "reply")
        record = result["items"][0]
        status, _ = self.request("PATCH", "/api/v1/tasks/" + record["id"], {"version": record["version"], "data": {"task_type": None}})
        self.assertEqual(status, 200)
        status, result = self.request("GET", "/api/v1/tasks?task_type=unclassified")
        self.assertEqual(status, 200)
        self.assertEqual(result["total"], 2)
        for value in ("made-up", [], 42):
            status, _ = self.request("POST", "/api/v1/tasks", {"title": "invalid", "data": {"task_type": value}})
            self.assertEqual(status, 400)
        status, _ = self.request("GET", "/api/v1/tasks?task_type=made-up")
        self.assertEqual(status, 400)

    def test_business_time_sort_for_other_lists(self):
        for resource, field, day_field in [
            ("actions", "occurred_at", "occurred_on"),
            ("contents", "published_at", "published_on"),
            ("metrics", "observed_at", None),
            ("reviews", "period_end", None),
            ("observations", "due_at", None),
        ]:
            with self.subTest(resource=resource):
                for title, instant in [("new", "2026-09-09T19:00:00+08:00"), ("old", "2026-09-08T23:00:00+08:00"), ("middle", "2026-09-09T10:00:00Z")]:
                    data = {field: instant}
                    if resource == "reviews": data["period_start"] = instant
                    if resource == "metrics": data.update(metric_name="views", metric_type="cumulative", value=0)
                    status, _ = self.request("POST", "/api/v1/" + resource, {"title": title, "data": data})
                    self.assertEqual(status, 201)
                expected = ["new", "middle", "old"]
                if day_field:
                    status, _ = self.request("POST", "/api/v1/" + resource, {"title": "day", "data": {day_field: "2026-09-09"}})
                    self.assertEqual(status, 201)
                    status, _ = self.request("POST", "/api/v1/" + resource, {"title": "missing", "data": {}})
                    self.assertEqual(status, 201)
                    expected = ["new", "middle", "day", "old", "missing"]
                actual = []
                for offset in range(0, len(expected), 2):
                    status, page = self.request("GET", f"/api/v1/{resource}?limit=2&offset={offset}")
                    self.assertEqual(status, 200)
                    actual.extend(row["title"] for row in page["items"])
                self.assertEqual(actual, expected)

    def test_skill_download_package_and_auth(self):
        files = [{"path": "SKILL.md", "content": "# Shared skill"}, {"path": "references/guide.md", "content": "完整说明"}]
        status, result = self.request("POST", "/api/v1/skills", {"title": "Shared", "data": {"slug": "shared-app", "files": files}})
        self.assertEqual(status, 201)
        path = "/api/v1/skills/" + result["item"]["id"] + "/download"
        for authorized in (False, True):
            conn = http.client.HTTPConnection("127.0.0.1", self.port)
            conn.request("GET", path, headers={"Authorization": "Bearer test-key"} if authorized else {})
            response = conn.getresponse(); body = response.read()
            self.assertEqual(response.status, 200 if authorized else 401)
            if authorized:
                self.assertEqual(response.getheader("Content-Type"), "application/zip")
                self.assertIn("shared-app-v1.zip", response.getheader("Content-Disposition"))
                with zipfile.ZipFile(io.BytesIO(body)) as package:
                    self.assertEqual(len(package.namelist()), 2)
                    self.assertEqual(package.read("shared-app/references/guide.md").decode(), "完整说明")
            conn.close()
        status, _ = self.request("PATCH", path, {})
        self.assertEqual(status, 405)

    def test_skill_download_fallback_and_unsafe_paths(self):
        record = {"id": "plain", "title": "Plain", "version": 2, "data": {"body": "Do the work."}}
        filename, payload = server_module.skill_download(record)
        self.assertEqual(filename, "plain-v2.zip")
        with zipfile.ZipFile(io.BytesIO(payload)) as package:
            self.assertIn("name: plain", package.read("plain/SKILL.md").decode())
        for path in ("../secret", "/absolute", "a/../../secret", "C:/secret", "a\\secret"):
            record["data"] = {"files": [{"path": "SKILL.md", "content": "ok"}, {"path": path, "content": "bad"}]}
            with self.assertRaises(server_module.ApiError): server_module.skill_download(record)
        for files in ([], [{"path": "notes.md", "content": "missing entry"}], [{"path": "SKILL.md", "content": "a"}, {"path": "skill.md", "content": "b"}]):
            record["data"] = {"files": files}
            with self.assertRaises(server_module.ApiError): server_module.skill_download(record)

    def account_id(self):
        status, accounts = self.request("GET", "/api/v1/accounts")
        self.assertEqual(status, 200)
        return accounts["items"][0]["id"]

    def create_product(self, title="Product"):
        status, product = self.request("POST", "/api/v1/products", {"title": title})
        self.assertEqual(status, 201)
        return product["item"]["id"]

    def test_business_time_filters_are_timezone_aware_and_do_not_backfill_missing_fields(self):
        account = self.account_id()
        status, early = self.request(
            "POST",
            "/api/v1/actions",
            {"title": "Early", "account_id": account, "data": {"action_type": "research", "occurred_at": "2026-09-08T08:30:00+08:00"}},
        )
        self.assertEqual(status, 201)
        status, boundary = self.request(
            "POST",
            "/api/v1/actions",
            {"title": "Boundary", "account_id": account, "data": {"action_type": "research", "occurred_at": "2026-09-08T00:31:00Z"}},
        )
        self.assertEqual(status, 201)
        status, missing_time = self.request("POST", "/api/v1/actions", {"title": "Missing time", "account_id": account})
        self.assertEqual(status, 201)

        status, filtered = self.request(
            "GET",
            "/api/v1/actions?time_field=occurred_at&date_from=2026-09-08T08:30:00%2B08:00&date_to=2026-09-08T08:30:00%2B08:00",
        )
        self.assertEqual(status, 200)
        self.assertEqual([item["id"] for item in filtered["items"]], [early["item"]["id"]])
        status, invalid = self.request("GET", "/api/v1/actions?time_field=occurred_at&date_from=2026-09-08")
        self.assertEqual(status, 400)
        status, reverse = self.request("GET", "/api/v1/actions?date_from=2026-09-09&date_to=2026-09-08")
        self.assertEqual(status, 400)
        status, default_list = self.request("GET", "/api/v1/actions")
        self.assertEqual(default_list["total"], 3)
        status, date_only = self.request("GET", "/api/v1/actions?date_from=2099-01-01")
        self.assertEqual(status, 200)
        self.assertEqual(date_only["total"], 0)

        status, review = self.request(
            "POST",
            "/api/v1/reviews",
            {
                "title": "Period review",
                "account_id": account,
                "data": {"period_start": "2026-09-01T00:00:00Z", "period_end": "2026-09-07T23:59:59Z"},
            },
        )
        self.assertEqual(status, 201)
        status, overlap = self.request("GET", "/api/v1/reviews?time_field=review_period&date_from=2026-09-07T00:00:00Z&date_to=2026-09-08T00:00:00Z")
        self.assertEqual(overlap["total"], 1)

    def test_reconciliation_reports_and_clears_only_with_real_evidence_and_effective_review(self):
        account = self.account_id()
        status, task = self.request("POST", "/api/v1/tasks", {"title": "Due task", "account_id": account, "data": {"due_at": "2026-09-08T00:00:00Z"}})
        self.assertEqual(status, 201)
        status, action = self.request(
            "POST",
            "/api/v1/actions",
            {
                "title": "Published",
                "account_id": account,
                "status": "completed",
                "data": {"action_type": "tweet", "verification_status": "not_applicable", "review_due_at": "2026-09-08T00:00:00Z"},
            },
        )
        self.assertEqual(status, 201)
        status, observation = self.request("POST", "/api/v1/observations", {"title": "Check data", "account_id": account, "data": {"due_at": "2026-09-08T00:00:00Z"}})
        self.assertEqual(status, 201)
        status, cancelled = self.request("POST", "/api/v1/tasks", {"title": "Cancelled task", "account_id": account, "status": "Cancelled", "data": {"due_at": "2026-09-08T00:00:00Z"}})
        self.assertEqual(status, 201)

        status, report = self.request("GET", "/api/v1/reconciliation?as_of=2026-09-09T00:00:00Z")
        self.assertEqual(status, 200)
        self.assertEqual(report["counts"]["overdue_task"], 1)
        self.assertEqual(report["counts"]["overdue_observation"], 1)
        self.assertEqual(report["counts"]["missing_evidence"], 1)
        self.assertEqual(report["counts"]["unverified_action"], 1)
        self.assertEqual(report["counts"]["review_due"], 1)

        self.request("PATCH", f"/api/v1/tasks/{task['item']['id']}", {"version": 1, "status": "completed"})
        self.request("PATCH", f"/api/v1/observations/{observation['item']['id']}", {"version": 1, "status": "completed"})
        self.request(
            "PATCH",
            f"/api/v1/actions/{action['item']['id']}",
            {
                "version": 1,
                "data": {
                    "external_id": "tweet-1",
                    "verification_status": "verified",
                    "verified_at": "2026-09-09T01:00:00Z",
                    "verification_evidence": "tweet exists",
                },
            },
        )
        self.request("POST", "/api/v1/reviews", {"title": "Draft does not clear", "account_id": account, "status": "draft", "data": {"action_id": action["item"]["id"]}})
        status, draft_report = self.request("GET", "/api/v1/reconciliation?kind=review_due&as_of=2026-09-09T00:00:00Z")
        self.assertEqual(draft_report["total"], 1)
        self.request("POST", "/api/v1/reviews", {"title": "Effective review", "account_id": account, "status": "completed", "data": {"action_id": action["item"]["id"]}})
        status, cleared = self.request("GET", "/api/v1/reconciliation?as_of=2026-09-09T00:00:00Z")
        self.assertEqual(status, 200)
        self.assertEqual(cleared["total"], 0)

        status, global_content = self.request("POST", "/api/v1/contents", {"title": "Global template"})
        self.assertEqual(status, 201)
        status, scoped_action = self.request(
            "POST",
            "/api/v1/actions",
            {"title": "Scoped review due", "account_id": account, "status": "completed", "data": {"content_id": global_content["item"]["id"], "review_due_at": "2026-09-08T00:00:00Z"}},
        )
        self.assertEqual(status, 201)
        status, global_review = self.request("POST", "/api/v1/reviews", {"title": "Global review", "status": "completed", "data": {"content_id": global_content["item"]["id"]}})
        self.assertEqual(status, 201)
        status, scoped_due = self.request("GET", "/api/v1/reconciliation?kind=review_due&as_of=2026-09-09T00:00:00Z")
        self.assertEqual(status, 200)
        self.assertEqual(scoped_due["total"], 1)
        self.assertEqual(scoped_due["items"][0]["record_id"], scoped_action["item"]["id"])

    def test_reconciliation_ignores_records_with_tracking_disabled(self):
        account = self.account_id()
        for resource, body in [
            ("tasks", {"title": "Historical due task", "account_id": account, "data": {"due_at": "2026-09-08T00:00:00Z", "tracking_enabled": False}}),
            ("observations", {"title": "Historical observation", "account_id": account, "data": {"due_at": "2026-09-08T00:00:00Z", "tracking_enabled": False}}),
            ("actions", {"title": "Historical post", "account_id": account, "status": "completed", "data": {"action_type": "tweet", "review_due_at": "2026-09-08T00:00:00Z", "tracking_enabled": False}}),
        ]:
            status, _ = self.request("POST", f"/api/v1/{resource}", body)
            self.assertEqual(status, 201)

        status, report = self.request("GET", "/api/v1/reconciliation?as_of=2026-09-09T00:00:00Z")
        self.assertEqual(status, 200)
        self.assertEqual(report["total"], 0)
        self.assertTrue(all(count == 0 for count in report["counts"].values()))

        status, invalid = self.request(
            "POST",
            "/api/v1/tasks",
            {"title": "Bad tracking flag", "account_id": account, "data": {"tracking_enabled": "false"}},
        )
        self.assertEqual(status, 400)
        self.assertEqual(invalid["error"]["code"], "invalid_data")

    def test_verified_action_target_change_downgrades_pending(self):
        account = self.account_id()
        status, content_a = self.request("POST", "/api/v1/contents", {"title": "A", "account_id": account})
        self.assertEqual(status, 201)
        status, content_b = self.request("POST", "/api/v1/contents", {"title": "B", "account_id": account})
        self.assertEqual(status, 201)
        status, action = self.request(
            "POST",
            "/api/v1/actions",
            {
                "title": "Verified",
                "account_id": account,
                "status": "completed",
                "data": {
                    "action_type": "tweet",
                    "content_id": content_a["item"]["id"],
                    "external_id": "tweet-1",
                    "verification_status": "verified",
                    "verified_at": "2026-09-08T01:00:00Z",
                    "verification_evidence": "tweet exists",
                },
            },
        )
        self.assertEqual(status, 201)
        status, changed = self.request("PATCH", f"/api/v1/actions/{action['item']['id']}", {"version": 1, "data": {"content_id": content_b["item"]["id"]}})
        self.assertEqual(status, 200)
        self.assertEqual(changed["item"]["data"]["verification_status"], "pending")
        status, report = self.request("GET", "/api/v1/reconciliation?kind=unverified_action&as_of=2026-09-09T00:00:00Z")
        self.assertEqual(report["total"], 1)

        status, verified = self.request(
            "POST",
            "/api/v1/actions",
            {
                "title": "Verified full patch",
                "account_id": account,
                "status": "completed",
                "data": {
                    "action_type": "tweet",
                    "content_id": content_a["item"]["id"],
                    "external_id": "tweet-full-1",
                    "verification_status": "verified",
                    "verified_at": "2026-09-08T01:00:00Z",
                    "verification_evidence": "old evidence",
                },
            },
        )
        self.assertEqual(status, 201)
        full_data = dict(verified["item"]["data"])
        full_data["external_id"] = "tweet-full-2"
        full_data["verified_at"] = "2026-09-08T09:00:00+08:00"
        status, full_patch = self.request(
            "PATCH",
            f"/api/v1/actions/{verified['item']['id']}",
            {"version": 1, "data": full_data},
        )
        self.assertEqual(status, 200)
        self.assertEqual(full_patch["item"]["data"]["verification_status"], "pending")
        self.assertIsNone(full_patch["item"]["data"]["verified_at"])
        self.assertIsNone(full_patch["item"]["data"]["verification_evidence"])
        self.assertEqual(full_patch["item"]["data"]["previous_verification"]["external_id"], "tweet-full-1")
        status, reasserted = self.request(
            "PATCH", f"/api/v1/actions/{verified['item']['id']}",
            {"version": full_patch["item"]["version"], "data": {"verification_status": "verified"}},
        )
        self.assertEqual(status, 400)
        self.assertEqual(reasserted["error"]["code"], "invalid_verification")

        status, invalid_status = self.request("POST", "/api/v1/actions", {"title": "Bad status type", "account_id": account, "data": {"verification_status": []}})
        self.assertEqual(status, 400)
        self.assertEqual(invalid_status["error"]["code"], "invalid_verification")
        status, invalid_evidence = self.request(
            "POST",
            "/api/v1/actions",
            {
                "title": "Bad evidence type",
                "account_id": account,
                "status": "completed",
                "data": {"action_type": "tweet", "external_id": ["tweet"], "verification_status": "verified", "verified_at": "2026-09-08T01:00:00Z", "verification_evidence": {"url": "x"}},
            },
        )
        self.assertEqual(status, 400)

    def test_action_context_locks_strategy_version_and_paginates_all_collections(self):
        account = self.account_id()
        product = self.create_product()
        status, strategy = self.request("POST", "/api/v1/strategies", {"title": "S1", "account_id": account, "product_id": product, "data": {"goal": "first"}})
        self.assertEqual(status, 201)
        strategy_id = strategy["item"]["id"]
        status, action = self.request("POST", "/api/v1/actions", {"title": "Act", "account_id": account, "product_id": product, "data": {"strategy_id": strategy_id}})
        self.assertEqual(status, 201)
        status, bad_verified = self.request(
            "POST",
            "/api/v1/actions",
            {
                "title": "Bad verified",
                "account_id": account,
                "product_id": product,
                "data": {"strategy_id": strategy_id, "action_type": "tweet", "verification_status": "verified"},
            },
        )
        self.assertEqual(bad_verified["error"]["code"], "invalid_verification")
        self.request("PATCH", f"/api/v1/strategies/{strategy_id}", {"version": 1, "title": "S2", "data": {"goal": "second"}})
        action_id = action["item"]["id"]
        status, repatched_action = self.request("PATCH", f"/api/v1/actions/{action_id}", {"version": 1, "data": {"strategy_id": strategy_id, "note": "same strategy id"}})
        self.assertEqual(status, 200)
        self.assertEqual(repatched_action["item"]["data"]["strategy_version"], 1)
        conn = server_module.connect()
        try:
            conn.execute(
                server_module.insert_sql(),
                {
                    "resource": "actions",
                    "id": "legacy-unpinned-action",
                    "title": "Legacy unpinned",
                    "account_id": account,
                    "product_id": product,
                    "status": "active",
                    "created_at": "2026-09-08T00:00:00Z",
                    "updated_at": "2026-09-08T00:00:00Z",
                    "version": 1,
                    "data": server_module.stable_json({"strategy_id": strategy_id}),
                },
            )
            conn.commit()
        finally:
            conn.close()
        status, legacy_patch = self.request(
            "PATCH",
            "/api/v1/actions/legacy-unpinned-action",
            {"version": 1, "data": {"strategy_id": strategy_id, "note": "same legacy strategy"}},
        )
        self.assertEqual(status, 200)
        self.assertNotIn("strategy_version", legacy_patch["item"]["data"])
        metric_ids = []
        for index in range(3):
            status, metric = self.request(
                "POST",
                "/api/v1/metrics",
                {
                    "title": f"M{index}",
                    "account_id": account,
                    "product_id": product,
                    "data": {"metric_name": "views", "metric_type": "cumulative", "value": index, "availability": "valid", "observed_at": f"2026-09-08T0{index}:00:00Z", "action_id": action_id},
                },
            )
            self.assertEqual(status, 201)
            metric_ids.append(metric["item"]["id"])
        for index, metric_id in enumerate(metric_ids):
            self.request("POST", "/api/v1/reviews", {"title": f"R{index}", "account_id": account, "product_id": product, "status": "completed", "data": {"metric_ids": [metric_id]}})
        status, reviews = self.request("GET", "/api/v1/reviews")
        review_ids = [item["id"] for item in reviews["items"]]
        for review_id in review_ids:
            self.request("POST", "/api/v1/tasks", {"title": f"Follow {review_id}", "account_id": account, "product_id": product, "data": {"review_id": review_id}})

        status, context = self.request("GET", f"/api/v1/actions/{action_id}/context?limit=1&offset=1")
        self.assertEqual(status, 200)
        self.assertEqual(context["strategy"]["title"], "S1")
        self.assertEqual(context["strategy_resolution"], "exact")
        self.assertEqual(context["strategy_resolution_detail"]["version"], 1)
        self.assertEqual(context["collections"]["metrics"]["total"], 3)
        self.assertEqual(len(context["collections"]["metrics"]["items"]), 1)
        self.assertEqual(context["collections"]["reviews"]["total"], 3)
        self.assertEqual(context["collections"]["follow_up_tasks"]["total"], 3)


if __name__ == "__main__":
    unittest.main()
