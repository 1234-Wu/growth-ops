import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class BackupTests(unittest.TestCase):
    def test_snapshot_is_consistent_and_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / 'source.sqlite3'
            target = Path(folder) / 'snapshot.sqlite3'
            with sqlite3.connect(source) as connection:
                connection.execute('PRAGMA journal_mode=WAL')
                connection.execute('CREATE TABLE records (id TEXT, data TEXT)')
                connection.execute('INSERT INTO records VALUES (?, ?)', ('a', json.dumps({'title': '运营记录'})))
                connection.commit()
                result = subprocess.run([sys.executable, str(ROOT / 'scripts/backup.py'), '--database', str(source), '--output', str(target)], capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                with sqlite3.connect(target) as saved:
                    self.assertEqual(saved.execute('SELECT id FROM records').fetchone()[0], 'a')
                    self.assertEqual(saved.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
                rejected = subprocess.run([sys.executable, str(ROOT / 'scripts/backup.py'), '--database', str(source), '--output', str(target)], capture_output=True, text=True)
                self.assertNotEqual(rejected.returncode, 0)
                self.assertEqual(target.stat().st_mode & 0o777, 0o600)

    def test_post_client_requires_retained_idempotency_key(self):
        with tempfile.TemporaryDirectory() as folder:
            key = Path(folder) / 'key'
            key.write_text('test-local-secret')
            body = Path(folder) / 'body.json'
            body.write_text('{"title":"Action"}')
            result = subprocess.run([sys.executable, str(ROOT / 'scripts/client.py'), 'POST', 'actions', '--key-file', str(key), '--body-file', str(body)], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('idempotency-key', result.stderr)
            self.assertNotIn('test-local-secret', result.stderr)


if __name__ == '__main__':
    unittest.main()
