import copy
import concurrent.futures
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


class ApiCase(unittest.TestCase):
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
        if (
            method == "POST"
            and path.startswith("/api/v1/")
            and path != "/api/v1/restore"
            and "Idempotency-Key" not in req_headers
        ):
            self.post_counter += 1
            req_headers["Idempotency-Key"] = f"auto-{self.post_counter}"
        conn.request(method, path, payload, req_headers)
        res = conn.getresponse()
        raw = res.read()
        conn.close()
        data = json.loads(raw.decode("utf-8")) if raw else None
        return res.status, data

    def account_id(self):
        status, accounts = self.request("GET", "/api/v1/accounts")
        self.assertEqual(status, 200)
        return accounts["items"][0]["id"]

    def metric_body(self, account_id, name, value, observed_at, availability="valid", metric_type="cumulative", extra=None):
        data = {
            "metric_name": name,
            "metric_type": metric_type,
            "value": value,
            "availability": availability,
            "observed_at": observed_at,
            "source": "manual",
        }
        if extra:
            data.update(extra)
        return {"title": name, "account_id": account_id, "data": data}

    def test_health_and_auth_and_seed(self):
        status, body = self.request("GET", "/health", token=None)
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        status, _ = self.request("GET", "/api/v1/meta", token=None)
        self.assertEqual(status, 401)
        status, body = self.request("GET", "/api/v1/accounts")
        self.assertEqual(status, 200)
        self.assertEqual(body["total"], 1)
        account = body["items"][0]
        self.assertEqual(account["title"], "示例工作室")
        self.assertEqual(account["data"]["handle"], "example_studio")

    def test_crud_refs_history_version_and_archive(self):
        account_id = self.account_id()
        status, product = self.request("POST", "/api/v1/products", {"title": "示例产品 A"})
        self.assertEqual(status, 201)
        product_id = product["item"]["id"]
        status, strategy = self.request(
            "POST",
            "/api/v1/strategies",
            {"title": "Cold start", "account_id": account_id, "product_id": product_id, "data": {"goal": "learn"}},
        )
        self.assertEqual(status, 201)
        strategy_id = strategy["item"]["id"]
        status, conflict = self.request(
            "PATCH",
            f"/api/v1/strategies/{strategy_id}",
            {"version": 99, "data": {"goal": "wrong"}},
        )
        self.assertEqual(status, 409)
        status, patched = self.request(
            "PATCH",
            f"/api/v1/strategies/{strategy_id}",
            {"version": 1, "title": "Cold start v2", "data": {"goal": "measure"}},
        )
        self.assertEqual(status, 200)
        self.assertEqual(patched["item"]["version"], 2)
        status, history = self.request("GET", f"/api/v1/strategies/{strategy_id}/history")
        self.assertEqual(status, 200)
        self.assertEqual([item["version"] for item in history["items"]], [1, 2])
        status, detail = self.request("GET", f"/api/v1/strategies/{strategy_id}")
        self.assertEqual(status, 200)
        self.assertEqual(detail["item"]["id"], strategy_id)
        status, task = self.request(
            "POST",
            "/api/v1/tasks",
            {"title": "Draft post", "account_id": account_id, "product_id": product_id, "data": {"strategy_id": strategy_id}},
        )
        self.assertEqual(status, 201)
        status, bad_ref = self.request(
            "POST",
            "/api/v1/actions",
            {"title": "bad", "account_id": account_id, "data": {"task_id": "missing"}},
        )
        self.assertEqual(status, 400)
        status, archived = self.request(
            "PATCH",
            f"/api/v1/tasks/{task['item']['id']}",
            {"version": 1, "status": "archived"},
        )
        self.assertEqual(status, 200)
        self.assertEqual(archived["item"]["status"], "archived")

    def test_idempotency_key_replay_conflict_and_resource_hash(self):
        headers = {"Idempotency-Key": "idem-1"}
        body = {"title": "Reusable note"}
        status, first = self.request("POST", "/api/v1/knowledge", body, headers=headers)
        self.assertEqual(status, 201)
        status, second = self.request("POST", "/api/v1/knowledge", body, headers=headers)
        self.assertEqual(status, 201)
        self.assertEqual(second["item"]["id"], first["item"]["id"])
        status, conflict = self.request("POST", "/api/v1/knowledge", {"title": "Changed"}, headers=headers)
        self.assertEqual(status, 409)
        self.assertEqual(conflict["error"]["code"], "idempotency_conflict")
        status, resource_conflict = self.request("POST", "/api/v1/observations", body, headers=headers)
        self.assertEqual(status, 409)

    def test_content_metric_refs_and_missing_scope_are_rejected(self):
        account_id = self.account_id()
        status, content = self.request("POST", "/api/v1/contents", {"title": "Post", "account_id": account_id})
        self.assertEqual(status, 201)
        status, metric = self.request(
            "POST",
            "/api/v1/metrics",
            self.metric_body(account_id, "likes", 3, "2026-09-08T09:00:00Z", extra={"content_id": content["item"]["id"]}),
        )
        self.assertEqual(status, 201)
        status, review = self.request(
            "POST",
            "/api/v1/reviews",
            {
                "title": "Review",
                "account_id": account_id,
                "data": {"content_id": content["item"]["id"], "metric_ids": [metric["item"]["id"]]},
            },
        )
        self.assertEqual(status, 201)
        self.assertEqual(review["item"]["data"]["metric_ids"], [metric["item"]["id"]])
        status, missing_scope = self.request(
            "POST",
            "/api/v1/reviews",
            {"title": "Invisible review", "data": {"content_id": content["item"]["id"]}},
        )
        self.assertEqual(status, 400)
        self.assertEqual(missing_scope["error"]["code"], "missing_reference_scope")
        status, bad_metric_ids = self.request(
            "POST",
            "/api/v1/reviews",
            {"title": "Bad metric ids", "account_id": account_id, "data": {"metric_ids": "not-list"}},
        )
        self.assertEqual(status, 400)

    def test_metrics_dashboard_context_filters_and_meta_openapi(self):
        account_id = self.account_id()
        status, old_metric = self.request(
            "POST", "/api/v1/metrics", self.metric_body(account_id, "followers", 10, "2026-09-08T09:00:00Z")
        )
        self.assertEqual(status, 201)
        status, newer_metric = self.request(
            "POST", "/api/v1/metrics", self.metric_body(account_id, "followers", 12, "2026-09-09T09:00:00Z")
        )
        self.assertEqual(status, 201)
        status, timezone_later = self.request(
            "POST", "/api/v1/metrics", self.metric_body(account_id, "followers", 13, "2026-09-09T08:30:00-01:00")
        )
        self.assertEqual(status, 201)
        status, empty_metric = self.request(
            "POST",
            "/api/v1/metrics",
            self.metric_body(account_id, "impressions", None, "2026-09-08T10:00:00+00:00", "missing", "interval"),
        )
        self.assertEqual(status, 201)
        status, invalid_metric = self.request(
            "POST", "/api/v1/metrics", self.metric_body(account_id, "bad", "ten", "2026-09-08T09:00:00Z")
        )
        self.assertEqual(status, 400)
        status, bool_metric = self.request(
            "POST", "/api/v1/metrics", self.metric_body(account_id, "bad_bool", True, "2026-09-08T09:00:00Z")
        )
        self.assertEqual(status, 400)
        status, nonvalid_with_value = self.request(
            "POST", "/api/v1/metrics", self.metric_body(account_id, "bad_missing", 1, "2026-09-08T09:00:00Z", "missing")
        )
        self.assertEqual(status, 400)
        status, missing_idem = self.request(
            "POST",
            "/api/v1/metrics",
            {"title": "No key"},
            headers={"Idempotency-Key": ""},
        )
        self.assertEqual(status, 400)
        self.assertEqual(missing_idem["error"]["code"], "idempotency_key_required")
        status, dash = self.request("GET", f"/api/v1/dashboard?account_id={account_id}")
        self.assertEqual(status, 200)
        self.assertEqual(dash["counts"]["metrics"], 4)
        self.assertEqual(dash["latest_metrics"][0]["data"]["value"], 13)
        status, patched_old_metric = self.request(
            "PATCH",
            f"/api/v1/metrics/{old_metric['item']['id']}",
            {"version": 1, "title": "Followers edited"},
        )
        self.assertEqual(status, 200)
        status, dash_after_edit = self.request("GET", f"/api/v1/dashboard?account_id={account_id}")
        self.assertEqual(dash_after_edit["latest_metrics"][0]["data"]["value"], 13)
        status, context = self.request("GET", f"/api/v1/accounts/{account_id}/context")
        self.assertEqual(status, 200)
        self.assertEqual(context["account"]["id"], account_id)
        self.assertEqual(context["platform"]["id"], "platform-x")
        self.assertEqual(len(context["metrics"]), 4)
        status, filtered = self.request("GET", f"/api/v1/metrics?account_id={account_id}&q=Followers&limit=1")
        self.assertEqual(status, 200)
        self.assertEqual(filtered["total"], 3)
        status, date_filtered = self.request("GET", "/api/v1/metrics?date_from=2099-01-01T00:00:00Z")
        self.assertEqual(status, 200)
        self.assertEqual(date_filtered["total"], 0)
        status, meta = self.request("GET", "/api/v1/meta")
        self.assertEqual(status, 200)
        self.assertEqual(meta["relation_list_fields_in_data"]["metric_ids"], "metrics")
        status, spec = self.request("GET", "/api/v1/openapi.json")
        self.assertEqual(status, 200)
        self.assertEqual(spec["servers"][0]["url"], "/")
        self.assertIn("/api/v1/accounts", spec["paths"])
        for path_item in spec["paths"].values():
            for method, operation in path_item.items():
                if method == "parameters":
                    continue
                self.assertIn("responses", operation)

    def test_export_restore_empty_only_and_version_validation(self):
        self.request("POST", "/api/v1/knowledge", {"title": "Exported"})
        status, strategy = self.request("POST", "/api/v1/strategies", {"title": "Versioned", "data": {"goal": "x"}})
        self.assertEqual(status, 201)
        status, exported = self.request("GET", "/api/v1/export")
        self.assertEqual(status, 200)
        self.assertGreaterEqual(len(exported["records"]), 4)
        status, restore_conflict = self.request("POST", "/api/v1/restore", exported)
        self.assertEqual(status, 409)

        invalid_orphan = copy.deepcopy(exported)
        invalid_orphan["versions"][0]["id"] = "missing"
        status, body = self.restore_into_empty(invalid_orphan)
        self.assertEqual(status, 404)
        self.assertEqual(body["error"]["code"], "not_found")

        invalid_resource = copy.deepcopy(exported)
        invalid_resource["versions"][0]["resource"] = "accounts"
        status, body = self.restore_into_empty(invalid_resource)
        self.assertEqual(status, 400)
        self.assertEqual(body["error"]["code"], "invalid_restore")

        invalid_version = copy.deepcopy(exported)
        invalid_version["versions"][0]["version"] = 99
        status, body = self.restore_into_empty(invalid_version)
        self.assertEqual(status, 400)
        self.assertEqual(body["error"]["code"], "invalid_restore")

        status, restored = self.restore_into_empty(exported)
        self.assertEqual(status, 200)
        self.assertEqual(restored["restored"], len(exported["records"]))

    def restore_into_empty(self, payload):
        other_tmp = tempfile.TemporaryDirectory()
        try:
            self.server.shutdown()
            self.server.server_close()
            self.thread.join(timeout=2)
            os.environ["GROWTH_DATA_DIR"] = other_tmp.name
            os.environ["GROWTH_SEED"] = "0"
            self.server = server_module.ThreadingHTTPServer(("127.0.0.1", 0), server_module.GrowthHandler)
            self.server.api_key = "test-key"
            server_module.init_db()
            self.port = self.server.server_address[1]
            self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
            self.thread.start()
            return self.request("POST", "/api/v1/restore", payload)
        finally:
            other_tmp.cleanup()

    def test_cross_origin_put_and_static_traversal_json_error(self):
        status, forbidden = self.request(
            "POST",
            "/api/v1/knowledge",
            {"title": "Blocked"},
            headers={"Origin": "https://evil.example"},
        )
        self.assertEqual(status, 403)
        self.assertEqual(forbidden["error"]["code"], "cross_origin_write_rejected")
        status, body = self.request("PUT", "/api/v1/tasks/1", {"title": "x"})
        self.assertEqual(status, 405)
        self.assertEqual(body["error"]["code"], "method_not_allowed")
        status, body = self.request("GET", "/../secret", token=None)
        self.assertEqual(status, 403)
        self.assertEqual(body["error"]["code"], "forbidden")
        status, body = self.request("GET", "/%2e%2e/data/api-key", token=None)
        self.assertEqual(status, 403)
        status, body = self.request("GET", "/missing-react-chunk.js", token=None)
        self.assertEqual(status, 404)
        self.assertEqual(body["error"]["code"], "not_found")

    def test_context_uses_active_strategy_and_includes_account_knowledge(self):
        account = self.account_id()
        _, active = self.request("POST", "/api/v1/strategies", {"title": "Active", "account_id": account, "status": "active"})
        self.request("POST", "/api/v1/strategies", {"title": "Draft", "account_id": account, "status": "draft"})
        _, lesson = self.request("POST", "/api/v1/knowledge", {"title": "Lesson", "account_id": account})
        _, content = self.request("POST", "/api/v1/contents", {"title": "Content", "account_id": account})
        status, context = self.request("GET", f"/api/v1/accounts/{account}/context")
        self.assertEqual(status, 200)
        self.assertEqual(context["current_strategy"]["id"], active["item"]["id"])
        self.assertIn(lesson["item"]["id"], [item["id"] for item in context["knowledge"]])
        self.assertIn(content["item"]["id"], [item["id"] for item in context["contents"]])

    def test_concurrent_retry_and_update_preserve_single_operation(self):
        body = {"title": "Concurrent action"}
        def create(_):
            return self.request("POST", "/api/v1/actions", body, headers={"Idempotency-Key": "concurrent-operation"})
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(create, range(6)))
        self.assertEqual({status for status, _ in results}, {201})
        self.assertEqual(len({result["item"]["id"] for _, result in results}), 1)
        _, listing = self.request("GET", "/api/v1/actions")
        self.assertEqual(listing["total"], 1)
        item = results[0][1]["item"]
        def update(title):
            return self.request("PATCH", "/api/v1/actions/" + item["id"], {"version": 1, "title": title})
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = list(pool.map(update, ["First writer", "Second writer"]))
        self.assertEqual(sorted(status for status, _ in outcomes), [200, 409])

    def test_invalid_inputs_are_actionable_client_errors(self):
        for payload in ({"title": []}, {"status": None}, {"account_id": {}}, {"data": []}):
            self.assertEqual(self.request("POST", "/api/v1/knowledge", payload)[0], 400)
        self.assertEqual(self.request("GET", "/api/v1/actions?limit=oops")[0], 400)
        self.assertEqual(self.request("POST", "/api/v1/dashboard", {})[0], 405)
        self.assertEqual(self.request("GET", "/api/v1/restore")[0], 405)
        body = self.metric_body(self.account_id(), "views", 0, "2026-09-08T10:00:00Z")
        body["data"]["metric_type"] = "not-a-type"
        self.assertEqual(self.request("POST", "/api/v1/metrics", body)[0], 400)
        body["data"]["metric_type"] = "cumulative"
        body["data"]["metric_name"] = ["views"]
        self.assertEqual(self.request("POST", "/api/v1/metrics", body)[0], 400)

    def test_business_time_filters_use_event_dates(self):
        account_id = self.account_id()
        status, historical_action = self.request(
            "POST",
            "/api/v1/actions",
            {
                "title": "Historical publish",
                "account_id": account_id,
                "status": "completed",
                "data": {"action_type": "tweet", "occurred_at": "2026-04-24T09:00:00+08:00"},
            },
        )
        self.assertEqual(status, 201)
        status, _ = self.request(
            "POST",
            "/api/v1/actions",
            {"title": "No occurred_at", "account_id": account_id, "status": "completed", "data": {"action_type": "research"}},
        )
        self.assertEqual(status, 201)
        status, occurred = self.request(
            "GET",
            "/api/v1/actions?time_field=occurred_at&date_from=2026-04-24T00:00:00%2B08:00&date_to=2026-04-24T23:59:59%2B08:00",
        )
        self.assertEqual(status, 200)
        self.assertEqual([item["id"] for item in occurred["items"]], [historical_action["item"]["id"]])
        status, invalid_time = self.request("GET", "/api/v1/actions?time_field=occurred_at&date_from=2026-04-24")
        self.assertEqual(status, 400)
        status, wrong_resource = self.request("GET", "/api/v1/actions?time_field=observed_at&date_from=2026-04-24T00:00:00Z")
        self.assertEqual(status, 400)

        status, metric = self.request(
            "POST",
            "/api/v1/metrics",
            self.metric_body(account_id, "views", 100, "2026-04-25T00:30:00+08:00", extra={"action_id": historical_action["item"]["id"]}),
        )
        self.assertEqual(status, 201)
        status, metric_filtered = self.request(
            "GET",
            "/api/v1/metrics?time_field=observed_at&date_from=2026-04-24T16:00:00Z&date_to=2026-04-24T17:00:00Z",
        )
        self.assertEqual(status, 200)
        self.assertEqual([item["id"] for item in metric_filtered["items"]], [metric["item"]["id"]])

        status, review = self.request(
            "POST",
            "/api/v1/reviews",
            {
                "title": "Period review",
                "account_id": account_id,
                "data": {
                    "action_id": historical_action["item"]["id"],
                    "period_start": "2026-04-20T00:00:00+08:00",
                    "period_end": "2026-04-30T23:59:59+08:00",
                },
            },
        )
        self.assertEqual(status, 201)
        status, review_filtered = self.request(
            "GET",
            "/api/v1/reviews?time_field=review_period&date_from=2026-04-25T00:00:00%2B08:00&date_to=2026-04-25T23:59:59%2B08:00",
        )
        self.assertEqual(status, 200)
        self.assertEqual([item["id"] for item in review_filtered["items"]], [review["item"]["id"]])
        status, bad_review = self.request(
            "POST",
            "/api/v1/reviews",
            {"title": "Bad period", "account_id": account_id, "data": {"period_start": "2026-04-30T00:00:00Z"}},
        )
        self.assertEqual(status, 400)

    def test_reconciliation_and_action_context_close_the_loop(self):
        account_id = self.account_id()
        status, product = self.request("POST", "/api/v1/products", {"title": "Analook"})
        self.assertEqual(status, 201)
        product_id = product["item"]["id"]
        status, strategy = self.request(
            "POST",
            "/api/v1/strategies",
            {"title": "X strategy", "account_id": account_id, "product_id": product_id, "data": {"body": "v1"}},
        )
        self.assertEqual(status, 201)
        status, strategy_v2 = self.request(
            "PATCH",
            f"/api/v1/strategies/{strategy['item']['id']}",
            {"version": 1, "data": {"body": "v2"}},
        )
        self.assertEqual(status, 200)
        status, task = self.request(
            "POST",
            "/api/v1/tasks",
            {
                "title": "Publish case thread",
                "account_id": account_id,
                "product_id": product_id,
                "status": "planned",
                "data": {"due_at": "2026-04-24T09:00:00+08:00", "strategy_id": strategy["item"]["id"]},
            },
        )
        self.assertEqual(status, 201)
        self.assertEqual(task["item"]["data"]["strategy_version"], strategy_v2["item"]["version"])
        status, content = self.request(
            "POST",
            "/api/v1/contents",
            {"title": "Case draft", "account_id": account_id, "product_id": product_id, "data": {"body": "draft"}},
        )
        self.assertEqual(status, 201)
        status, action = self.request(
            "POST",
            "/api/v1/actions",
            {
                "title": "Published X post",
                "account_id": account_id,
                "product_id": product_id,
                "status": "completed",
                "data": {
                    "action_type": "tweet",
                    "task_id": task["item"]["id"],
                    "content_id": content["item"]["id"],
                    "strategy_id": strategy["item"]["id"],
                    "occurred_at": "2026-04-24T10:00:00+08:00",
                    "review_due_at": "2026-04-26T10:00:00+08:00",
                },
            },
        )
        self.assertEqual(status, 201)
        action_id = action["item"]["id"]
        self.assertEqual(action["item"]["data"]["strategy_version"], strategy_v2["item"]["version"])
        self.request(
            "POST",
            "/api/v1/actions",
            {"title": "Manual research", "account_id": account_id, "status": "completed", "data": {"requires_verification": True}},
        )
        status, reconciliation = self.request(
            "GET",
            f"/api/v1/reconciliation?account_id={account_id}&as_of=2026-04-27T00:00:00%2B08:00",
        )
        self.assertEqual(status, 200)
        self.assertEqual(reconciliation["counts"]["missing_evidence"], 1)
        self.assertEqual(reconciliation["counts"]["unverified_action"], 2)
        self.assertEqual(reconciliation["counts"]["review_due"], 1)
        self.assertEqual(reconciliation["counts"]["overdue_task"], 1)
        status, missing_only = self.request(
            "GET",
            f"/api/v1/reconciliation?account_id={account_id}&kind=missing_evidence&as_of=2026-04-27T00:00:00%2B08:00",
        )
        self.assertEqual(status, 200)
        self.assertEqual(missing_only["total"], 1)

        status, metric = self.request(
            "POST",
            "/api/v1/metrics",
            {
                **self.metric_body(account_id, "views", 1200, "2026-04-25T10:00:00+08:00", extra={"action_id": action_id}),
                "product_id": product_id,
            },
        )
        self.assertEqual(status, 201)
        status, review = self.request(
            "POST",
            "/api/v1/reviews",
            {
                "title": "Post review",
                "account_id": account_id,
                "product_id": product_id,
                "data": {
                    "action_id": action_id,
                    "metric_ids": [metric["item"]["id"]],
                    "period_start": "2026-04-24T00:00:00+08:00",
                    "period_end": "2026-04-26T23:59:59+08:00",
                },
            },
        )
        self.assertEqual(status, 201)
        status, follow_up_task = self.request(
            "POST",
            "/api/v1/tasks",
            {"title": "Improve hook", "account_id": account_id, "product_id": product_id, "data": {"review_id": review["item"]["id"]}},
        )
        self.assertEqual(status, 201)
        status, follow_up_action = self.request(
            "POST",
            "/api/v1/actions",
            {"title": "Rewrite hook", "account_id": account_id, "product_id": product_id, "data": {"parent_action_id": action_id}},
        )
        self.assertEqual(status, 201)
        status, patched = self.request(
            "PATCH",
            f"/api/v1/actions/{action_id}",
            {
                "version": action["item"]["version"],
                "data": {
                    "external_id": "tweet-1",
                    "verification_status": "verified",
                    "verified_at": "2026-04-24T10:01:00+08:00",
                    "verification_evidence": "fetched tweet by id",
                },
            },
        )
        self.assertEqual(status, 200)
        status, context = self.request("GET", f"/api/v1/actions/{action_id}/context?limit=1")
        self.assertEqual(status, 200)
        self.assertEqual(context["action"]["id"], action_id)
        self.assertEqual(context["task"]["id"], task["item"]["id"])
        self.assertEqual(context["content"]["id"], content["item"]["id"])
        self.assertEqual(context["strategy_resolution"], "exact")
        self.assertEqual(context["strategy"]["version"], strategy_v2["item"]["version"])
        self.assertEqual(context["collections"]["metrics"]["total"], 1)
        self.assertEqual(context["collections"]["reviews"]["total"], 1)
        self.assertEqual(context["collections"]["follow_up_tasks"]["items"][0]["id"], follow_up_task["item"]["id"])
        self.assertEqual(context["collections"]["follow_up_actions"]["items"][0]["id"], follow_up_action["item"]["id"])
        status, after = self.request(
            "GET",
            f"/api/v1/reconciliation?account_id={account_id}&kind=missing_evidence&as_of=2026-04-27T00:00:00%2B08:00",
        )
        self.assertEqual(status, 200)
        self.assertEqual(after["total"], 0)


if __name__ == "__main__":
    unittest.main()
