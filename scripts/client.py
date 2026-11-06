#!/usr/bin/env python3
"""Small stdlib client: reads secrets from environment or a private file."""
import argparse
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.request


def main():
    parser = argparse.ArgumentParser(description='Growth Ops API client')
    parser.add_argument('method', choices=['GET', 'POST', 'PATCH'])
    parser.add_argument('path', help='Path relative to /api/v1, e.g. accounts')
    parser.add_argument('--base', default=os.environ.get('GROWTH_API_URL', 'http://127.0.0.1:8787/api/v1'))
    parser.add_argument('--body-file', type=Path)
    parser.add_argument('--key-file', type=Path, default=Path(__file__).resolve().parents[1] / 'data' / 'api-key')
    parser.add_argument('--idempotency-key', help='Persist this key and reuse it for the same logical POST')
    args = parser.parse_args()
    key = os.environ.get('GROWTH_API_KEY')
    if not key and args.key_file.exists():
        key = args.key_file.read_text().strip()
    if not key:
        parser.error('Set GROWTH_API_KEY or provide --key-file')
    if args.method == 'POST' and not args.idempotency_key:
        parser.error('POST requires --idempotency-key; retain it for safe retries')
    payload = None
    if args.body_file:
        payload = json.dumps(json.loads(args.body_file.read_text()), ensure_ascii=False).encode()
    elif args.method != 'GET':
        parser.error('POST/PATCH requires --body-file')
    if '://' in args.path or args.path.startswith('//') or '..' in args.path.split('/'):
        parser.error('path must be relative to the API base')
    headers = {'Authorization': 'Bearer ' + key, 'Accept': 'application/json'}
    if payload is not None:
        headers['Content-Type'] = 'application/json'
    if args.idempotency_key:
        headers['Idempotency-Key'] = args.idempotency_key
    request = urllib.request.Request(args.base.rstrip('/') + '/' + args.path.lstrip('/'), data=payload, headers=headers, method=args.method)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            result = json.loads(response.read())
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except urllib.error.HTTPError as error:
        print(f'HTTP {error.code}: {error.read().decode()}', file=sys.stderr)
        return 1
    except urllib.error.URLError as error:
        print(f'Connection failed: {error.reason}. If a write outcome is uncertain, retry only the same payload and key.', file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
