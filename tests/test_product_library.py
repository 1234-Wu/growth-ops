import base64
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
spec = importlib.util.spec_from_file_location("growth_ops_server_library", SERVER_PATH)
server_module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(server_module)


class ProductLibraryCase(unittest.TestCase):
    def setUp(self):
        self.post_counter = 0
        self.tmp = tempfile.TemporaryDirectory()
        self.old_data_dir = os.environ.get("GROWTH_DATA_DIR")
        self.old_key = os.environ.get("GROWTH_API_KEY")
        self.old_seed = os.environ.get("GROWTH_SEED")
        self.old_allowed_origins = os.environ.get("GROWTH_ALLOWED_ORIGINS")
        os.environ["GROWTH_DATA_DIR"] = self.tmp.name
        os.environ["GROWTH_API_KEY"] = "test-key"
        os.environ.pop("GROWTH_SEED", None)
        os.environ.pop("GROWTH_ALLOWED_ORIGINS", None)
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
        if self.old_allowed_origins is None:
            os.environ.pop("GROWTH_ALLOWED_ORIGINS", None)
        else:
            os.environ["GROWTH_ALLOWED_ORIGINS"] = self.old_allowed_origins
        for extra_tmp in getattr(self, "extra_tmps", []):
            extra_tmp.cleanup()
        self.tmp.cleanup()

    def request(self, method, path, body=None, token="test-key", headers=None):
        status, raw, response_headers = self.raw_request(method, path, body, token, headers)
        data = json.loads(raw.decode("utf-8")) if raw else None
        return status, data, response_headers

    def raw_request(self, method, path, body=None, token="test-key", headers=None):
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
            req_headers["Idempotency-Key"] = f"auto-library-{self.post_counter}"
        conn.request(method, path, payload, req_headers)
        res = conn.getresponse()
        raw = res.read()
        response_headers = dict(res.getheaders())
        conn.close()
        return res.status, raw, response_headers

    def create_product(self, title):
        status, body, _ = self.request("POST", "/api/v1/products", {"title": title})
        self.assertEqual(status, 201)
        return body["item"]["id"]

    def restore_into_empty(self, payload):
        other_tmp = tempfile.TemporaryDirectory()
        if not hasattr(self, "extra_tmps"):
            self.extra_tmps = []
        self.extra_tmps.append(other_tmp)
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

    def test_product_library_crud_download_history_and_restore(self):
        product_id = self.create_product("示例产品 A")
        other_product_id = self.create_product("示例产品 B")
        asset_bytes = b"\x89PNG\r\npromo-screenshot"
        asset_payload = {
            "kind": "asset",
            "title": "App Store screenshot",
            "category": "product_screenshot",
            "body": "Public-ready App Store screenshot.",
            "filename": "../promo.png",
            "mime_type": "image/png",
            "content_base64": base64.b64encode(asset_bytes).decode("ascii"),
            "source_path": "/local/app/screenshots/promo.png",
        }
        headers = {"Idempotency-Key": "library-asset-1"}
        status, first, _ = self.request("POST", f"/api/v1/products/{product_id}/library", asset_payload, headers=headers)
        self.assertEqual(status, 201)
        entry = first["item"]
        self.assertEqual(entry["kind"], "asset")
        self.assertEqual(entry["size_bytes"], len(asset_bytes))
        self.assertNotIn("content_base64", entry)
        self.assertNotIn("content", entry)

        status, replay, _ = self.request("POST", f"/api/v1/products/{product_id}/library", asset_payload, headers=headers)
        self.assertEqual(status, 201)
        self.assertEqual(replay["item"]["id"], entry["id"])
        status, conflict, _ = self.request(
            "POST",
            f"/api/v1/products/{product_id}/library",
            {**asset_payload, "title": "Changed"},
            headers=headers,
        )
        self.assertEqual(status, 409)
        self.assertEqual(conflict["error"]["code"], "idempotency_conflict")

        status, cross_product, _ = self.request("GET", f"/api/v1/products/{other_product_id}/library/{entry['id']}")
        self.assertEqual(status, 404)
        status, bad_patch, _ = self.request(
            "PATCH",
            f"/api/v1/products/{product_id}/library/{entry['id']}",
            {"version": 99, "body": "wrong"},
        )
        self.assertEqual(status, 409)

        replacement = b"second-version"
        status, patched, _ = self.request(
            "PATCH",
            f"/api/v1/products/{product_id}/library/{entry['id']}",
            {
                "version": entry["version"],
                "body": "Updated metadata for the screenshot.",
                "source_path": "/local/app/screenshots/promo-v2.png",
                "content_base64": base64.b64encode(replacement).decode("ascii"),
            },
        )
        self.assertEqual(status, 200)
        self.assertEqual(patched["item"]["version"], 2)
        self.assertEqual(patched["item"]["size_bytes"], len(replacement))
        self.assertNotIn("content_base64", patched["item"])

        status, listing, _ = self.request("GET", f"/api/v1/products/{product_id}/library?kind=asset&category=product_screenshot&q=screenshot")
        self.assertEqual(status, 200)
        self.assertEqual(listing["total"], 1)
        status, hidden_by_category, _ = self.request("GET", f"/api/v1/products/{product_id}/library?category=icon")
        self.assertEqual(status, 200)
        self.assertEqual(hidden_by_category["total"], 0)
        status, detail, _ = self.request("GET", f"/api/v1/products/{product_id}/library/{entry['id']}")
        self.assertEqual(status, 200)
        self.assertEqual(detail["item"]["body"], "Updated metadata for the screenshot.")
        self.assertNotIn("content_base64", detail["item"])

        status, downloaded, response_headers = self.raw_request("GET", f"/api/v1/products/{product_id}/library/{entry['id']}/download")
        self.assertEqual(status, 200)
        self.assertEqual(downloaded, replacement)
        self.assertEqual(response_headers["Content-Type"], "image/png")
        self.assertIn("attachment", response_headers["Content-Disposition"])

        status, history, _ = self.request("GET", f"/api/v1/products/{product_id}/library/{entry['id']}/history")
        self.assertEqual(status, 200)
        self.assertEqual([item["version"] for item in history["items"]], [1, 2])
        self.assertEqual(history["items"][0]["size_bytes"], len(asset_bytes))
        self.assertNotIn("content_base64", history["items"][0])
        self.assertNotIn("content", history["items"][0])

        status, exported, _ = self.request("GET", "/api/v1/export")
        self.assertEqual(status, 200)
        self.assertEqual(len(exported["product_library_entries"]), 1)
        self.assertEqual(len(exported["product_library_versions"]), 2)
        self.assertEqual(base64.b64decode(exported["product_library_entries"][0]["content_base64"]), replacement)

        status, restored, _ = self.restore_into_empty(exported)
        self.assertEqual(status, 200)
        self.assertEqual(restored["product_library_entries"], 1)
        self.assertEqual(restored["product_library_versions"], 2)
        status, restored_download, _ = self.raw_request("GET", f"/api/v1/products/{product_id}/library/{entry['id']}/download")
        self.assertEqual(status, 200)
        self.assertEqual(restored_download, replacement)

    def test_product_library_auth_and_document_archive_defaults(self):
        product_id = self.create_product("示例产品 B")
        status, unauthorized, _ = self.request("GET", f"/api/v1/products/{product_id}/library", token="wrong-key")
        self.assertEqual(status, 401)
        self.assertEqual(unauthorized["error"]["code"], "unauthorized")

        status, document, _ = self.request(
            "POST",
            f"/api/v1/products/{product_id}/library",
            {
                "kind": "document",
                "title": "Core positioning",
                "category": "brief",
                "body": "    示例产品 B promotion positioning.\n",
                "source_path": "产品推广/示例产品 B/示例产品 B-X推广计划.md",
            },
        )
        self.assertEqual(status, 201)
        entry_id = document["item"]["id"]
        status, archived, _ = self.request(
            "PATCH",
            f"/api/v1/products/{product_id}/library/{entry_id}",
            {"version": 1, "status": "archived"},
        )
        self.assertEqual(status, 200)
        self.assertEqual(archived["item"]["status"], "archived")

        status, visible, _ = self.request("GET", f"/api/v1/products/{product_id}/library")
        self.assertEqual(status, 200)
        self.assertEqual(visible["total"], 0)
        status, archived_list, _ = self.request("GET", f"/api/v1/products/{product_id}/library?status=archived")
        self.assertEqual(status, 200)
        self.assertEqual(archived_list["total"], 1)
        status, all_entries, _ = self.request("GET", f"/api/v1/products/{product_id}/library?status=all")
        self.assertEqual(status, 200)
        self.assertEqual(all_entries["total"], 1)
        status, downloaded, headers = self.raw_request("GET", f"/api/v1/products/{product_id}/library/{entry_id}/download")
        self.assertEqual(status, 200)
        self.assertEqual(downloaded, "    示例产品 B promotion positioning.\n".encode("utf-8"))
        self.assertTrue(headers["Content-Type"].startswith("text/markdown"))

    def test_allowed_origin_is_explicit_and_still_authenticated(self):
        status, rejected, _ = self.request(
            "POST",
            "/api/v1/products",
            {"title": "Blocked"},
            headers={"Origin": "http://127.0.0.1:3000"},
        )
        self.assertEqual(status, 403)
        self.assertEqual(rejected["error"]["code"], "cross_origin_write_rejected")

        os.environ["GROWTH_ALLOWED_ORIGINS"] = "http://127.0.0.1:3000"
        status, unauthorized, _ = self.request(
            "POST",
            "/api/v1/products",
            {"title": "No auth"},
            token="wrong-key",
            headers={"Origin": "http://127.0.0.1:3000"},
        )
        self.assertEqual(status, 401)
        self.assertEqual(unauthorized["error"]["code"], "unauthorized")
        status, created, _ = self.request(
            "POST",
            "/api/v1/products",
            {"title": "Allowed"},
            headers={"Origin": "http://127.0.0.1:3000"},
        )
        self.assertEqual(status, 201)
        self.assertEqual(created["item"]["title"], "Allowed")


if __name__ == "__main__":
    unittest.main()
