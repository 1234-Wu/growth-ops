import copy
import importlib.util
import os
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = ROOT / "server.py"
spec = importlib.util.spec_from_file_location("growth_ops_server_restore", SERVER_PATH)
server_module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(server_module)


class RestoreExtraCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_data_dir = os.environ.get("GROWTH_DATA_DIR")
        self.old_seed = os.environ.get("GROWTH_SEED")
        os.environ["GROWTH_DATA_DIR"] = self.tmp.name
        os.environ["GROWTH_SEED"] = "0"
        server_module.init_db()
        self.conn = server_module.connect()

    def tearDown(self):
        self.conn.close()
        if self.old_data_dir is None:
            os.environ.pop("GROWTH_DATA_DIR", None)
        else:
            os.environ["GROWTH_DATA_DIR"] = self.old_data_dir
        if self.old_seed is None:
            os.environ.pop("GROWTH_SEED", None)
        else:
            os.environ["GROWTH_SEED"] = self.old_seed
        self.tmp.cleanup()

    def record(self, resource, item_id, title, version=1, data=None, account_id=None, product_id=None):
        return {
            "resource": resource,
            "id": item_id,
            "title": title,
            "account_id": account_id,
            "product_id": product_id,
            "status": "active",
            "created_at": "2026-09-08T00:00:00Z",
            "updated_at": "2026-09-08T00:00:00Z",
            "version": version,
            "data": data or {},
        }

    def valid_payload(self):
        platform = self.record("platforms", "platform-x", "X")
        account = self.record("accounts", "account-x", "示例工作室", data={"platform_id": "platform-x"})
        strategy = self.record("strategies", "strategy-1", "Strategy v2", 2, {"goal": "measure"}, "account-x")
        strategy_v1 = self.record("strategies", "strategy-1", "Strategy v1", 1, {"goal": "learn"}, "account-x")
        return {
            "schema_version": 1,
            "records": [platform, account, strategy],
            "versions": [strategy_v1, copy.deepcopy(strategy)],
        }

    def assert_restore_error(self, payload, status=400, code="invalid_restore"):
        with self.assertRaises(server_module.ApiError) as raised:
            server_module.restore_all(self.conn, payload)
        self.assertEqual(raised.exception.status, status)
        self.assertEqual(raised.exception.code, code)

    def count_records(self):
        return self.conn.execute("SELECT COUNT(*) AS c FROM records").fetchone()["c"]

    def test_restore_accepts_valid_payload(self):
        result = server_module.restore_all(self.conn, self.valid_payload())
        self.assertEqual(result, {"restored": 3, "versions": 2})
        self.assertEqual(self.count_records(), 3)

    def test_restore_rejects_missing_id_and_bad_version_as_400(self):
        missing_id = self.valid_payload()
        del missing_id["records"][0]["id"]
        self.assert_restore_error(missing_id)
        self.assertEqual(self.count_records(), 0)

        bad_version = self.valid_payload()
        bad_version["records"][2]["version"] = "2"
        self.assert_restore_error(bad_version)
        self.assertEqual(self.count_records(), 0)

    def test_restore_requires_schema_version_one_and_data_object(self):
        bad_schema = self.valid_payload()
        bad_schema["schema_version"] = 2
        self.assert_restore_error(bad_schema)

        bad_data = self.valid_payload()
        bad_data["records"][0]["data"] = []
        self.assert_restore_error(bad_data)

    def test_restore_rejects_current_history_mismatch_and_noncontinuous_versions(self):
        mismatch = self.valid_payload()
        mismatch["versions"][1]["data"] = {"goal": "different"}
        self.assert_restore_error(mismatch)
        self.assertEqual(self.count_records(), 0)

        noncontinuous = self.valid_payload()
        noncontinuous["versions"] = [noncontinuous["versions"][1]]
        self.assert_restore_error(noncontinuous)
        self.assertEqual(self.count_records(), 0)

    def test_restore_rejects_orphan_and_nonversioned_history(self):
        orphan = self.valid_payload()
        orphan["versions"][0]["id"] = "missing"
        self.assert_restore_error(orphan, status=404, code="not_found")

        nonversioned = self.valid_payload()
        nonversioned["versions"][0] = copy.deepcopy(nonversioned["records"][1])
        self.assert_restore_error(nonversioned)

    def test_restore_failure_is_atomic_after_inserts(self):
        payload = self.valid_payload()
        payload["records"][1]["data"]["platform_id"] = "missing-platform"
        self.assert_restore_error(payload, code="invalid_reference")
        self.assertEqual(self.count_records(), 0)

    def test_restore_rejects_nonempty_inside_transaction(self):
        self.conn.execute(
            server_module.insert_sql(),
            {
                **self.record("platforms", "existing", "Existing"),
                "data": "{}",
            },
        )
        self.conn.commit()
        self.assert_restore_error(self.valid_payload(), status=409, code="restore_not_empty")


if __name__ == "__main__":
    unittest.main()
