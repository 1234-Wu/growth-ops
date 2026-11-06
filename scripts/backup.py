#!/usr/bin/env python3
"""Create and verify a consistent SQLite snapshot; never overwrite a backup."""
import argparse
import os
from pathlib import Path
import sqlite3


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', type=Path, help='SQLite source; auto-detect in GROWTH_DATA_DIR or data/')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    source = args.database
    if source is None:
        data_dir = Path(os.environ.get('GROWTH_DATA_DIR', Path(__file__).resolve().parents[1] / 'data'))
        candidates = sorted(set(data_dir.glob('*.sqlite3')) | set(data_dir.glob('*.sqlite')) | set(data_dir.glob('*.db')))
        if len(candidates) != 1:
            parser.error('Pass --database: expected exactly one SQLite file in the data directory')
        source = candidates[0]
    source = source.resolve(strict=True)
    target = args.output.resolve()
    if target == source or target.exists():
        parser.error('Output must be a new file distinct from the database')
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(descriptor)
    try:
        with sqlite3.connect(source.as_uri() + '?mode=ro', uri=True) as original:
            with sqlite3.connect(target) as backup:
                original.backup(backup)
                result = backup.execute('PRAGMA integrity_check').fetchone()[0]
                if result != 'ok':
                    raise RuntimeError('Backup integrity check failed')
        print(f'Verified SQLite backup: {target}')
    except BaseException:
        target.unlink(missing_ok=True)
        raise


if __name__ == '__main__':
    main()
