import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from api_schema import build_openapi


class ContractTests(unittest.TestCase):
    def test_all_routes_have_usable_responses_and_path_parameters(self):
        schema = build_openapi()
        self.assertEqual(schema["servers"][0]["url"], "/")
        ids = []
        for path, entry in schema["paths"].items():
            if "{id}" in path:
                self.assertTrue(any(p.get("name") == "id" and p.get("required") for p in entry.get("parameters", [])), path)
            for method in ("get", "post", "patch"):
                if method not in entry:
                    continue
                operation = entry[method]
                self.assertTrue(operation.get("responses"), (path, method))
                ids.append(operation["operationId"])
                if method in ("post", "patch"):
                    self.assertTrue(operation["requestBody"]["required"])
        self.assertEqual(len(ids), len(set(ids)))
        self.assertIn("/api/v1/accounts/{id}/context", schema["paths"])
        self.assertIn("/api/v1/skills/{id}/history", schema["paths"])

    def test_schema_references_resolve(self):
        schema = build_openapi()
        def walk(node):
            if isinstance(node, dict):
                if "$ref" in node:
                    target = schema
                    for part in node["$ref"].removeprefix("#/").split("/"):
                        target = target[part]
                for child in node.values():
                    walk(child)
            elif isinstance(node, list):
                for child in node:
                    walk(child)
        walk(schema)
