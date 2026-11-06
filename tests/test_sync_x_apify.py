import os
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

import server
from scripts.sync_x_apify import sync_twitter_items


class TwitterImportOwnershipCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_data_dir = os.environ.get("GROWTH_DATA_DIR")
        self.old_seed = os.environ.get("GROWTH_SEED")
        os.environ["GROWTH_DATA_DIR"] = self.tmp.name
        os.environ.pop("GROWTH_SEED", None)
        server.init_db()
        self.db_file = Path(self.tmp.name) / "growth.sqlite3"

    def tearDown(self):
        if self.old_data_dir is None:
            os.environ.pop("GROWTH_DATA_DIR", None)
        else:
            os.environ["GROWTH_DATA_DIR"] = self.old_data_dir
        if self.old_seed is None:
            os.environ.pop("GROWTH_SEED", None)
        else:
            os.environ["GROWTH_SEED"] = self.old_seed
        self.tmp.cleanup()

    def records(self, resource):
        conn = server.connect()
        try:
            return server.records_by_resource(conn, resource)
        finally:
            conn.close()

    def test_explicit_account_imports_only_matching_author(self):
        rows = [
            {
                "id": "100",
                "username": "example_studio",
                "tweet_type": "original",
                "text": "Own post",
                "view_count": "12",
            },
            {
                "id": "101",
                "username": "external_author",
                "tweet_type": "original",
                "text": "Reply target included by exporter",
                "view_count": "900",
            },
            {
                "id": "102",
                "username": "@example_studio",
                "tweet_type": "reply",
                "text": "Own reply",
                "in_reply_to_status_id": "101",
                "in_reply_to_screen_name": "external_author",
                "conversation_id": "101",
                "view_count": "7",
            },
        ]

        stats = sync_twitter_items(rows, db_file=self.db_file, account_id="account-example-x")

        self.assertEqual(stats["synced_posts"], 2)
        self.assertEqual(stats["skipped_external"], 1)
        actions = self.records("actions")
        self.assertEqual({a["data"]["external_id"] for a in actions}, {"100", "102"})
        reply = next(a for a in actions if a["data"]["external_id"] == "102")
        self.assertEqual(reply["data"]["action_type"], "reply")
        self.assertEqual(reply["data"]["in_reply_to_status_id"], "101")
        self.assertEqual(reply["data"]["in_reply_to_screen_name"], "external_author")

    def test_single_account_is_not_a_fallback_for_external_author(self):
        stats = sync_twitter_items(
            [{"id": "200", "username": "someone_else", "text": "External"}],
            db_file=self.db_file,
        )

        self.assertEqual(stats["synced_posts"], 0)
        self.assertEqual(stats["skipped_external"], 1)
        self.assertEqual(self.records("actions"), [])

    def test_retweet_and_quote_keep_their_action_types(self):
        rows = [
            {"id": "300", "username": "example_studio", "tweet_type": "retweet", "text": "RT"},
            {"id": "301", "username": "example_studio", "tweet_type": "quote", "text": "Quote"},
        ]

        stats = sync_twitter_items(rows, db_file=self.db_file, account_id="account-example-x")

        self.assertEqual(stats["synced_posts"], 2)
        by_id = {a["data"]["external_id"]: a for a in self.records("actions")}
        self.assertEqual(by_id["300"]["data"]["action_type"], "repost")
        self.assertEqual(by_id["300"]["data"]["source_tweet_type"], "retweet")
        self.assertEqual(by_id["301"]["data"]["action_type"], "quote")
        self.assertEqual(by_id["301"]["data"]["source_tweet_type"], "quote")

    def test_numeric_zero_metrics_are_recorded_as_valid_snapshots(self):
        stats = sync_twitter_items(
            [{
                "id": "350",
                "username": "example_studio",
                "tweet_type": "original",
                "text": "Zero metrics",
                "view_count": 0,
                "favorite_count": 0,
                "reply_count": 0,
                "retweet_count": 0,
                "bookmark_count": 0,
            }],
            db_file=self.db_file,
            account_id="account-example-x",
        )

        self.assertEqual(stats["synced_metrics"], 5)
        metrics = self.records("metrics")
        self.assertEqual(len(metrics), 5)
        self.assertEqual({metric["data"]["value"] for metric in metrics}, {0})

    def test_explicit_account_requires_a_known_handle(self):
        with self.assertRaisesRegex(ValueError, "not found"):
            sync_twitter_items(
                [{"id": "400", "username": "example_studio", "text": "Own"}],
                db_file=self.db_file,
                account_id="missing",
            )

    def test_dashboard_excludes_cancelled_actions_and_their_metrics(self):
        conn = server.connect()
        try:
            with conn:
                action = server.build_record(
                    "actions",
                    {
                        "title": "External context",
                        "account_id": "account-example-x",
                        "status": "cancelled",
                        "data": {"action_type": "publish", "external_id": "500"},
                    },
                )
                server.insert_record(conn, action)
                metric = server.build_record(
                    "metrics",
                    {
                        "title": "External views",
                        "account_id": "account-example-x",
                        "status": "active",
                        "data": {
                            "action_id": action["id"],
                            "metric_name": "views",
                            "metric_type": "cumulative",
                            "value": 999,
                            "observed_at": "2026-09-11T00:00:00Z",
                        },
                    },
                )
                server.insert_record(conn, metric)
            result = server.dashboard(conn, {"account_id": ["account-example-x"]})
        finally:
            conn.close()

        self.assertEqual(result["counts"]["actions"], 0)
        self.assertEqual(result["kpis"]["total_actions"], 0)
        self.assertEqual(result["kpis"]["total_views"], 0)


if __name__ == "__main__":
    unittest.main()
