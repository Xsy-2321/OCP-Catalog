"""Conformance checks for the minimal Python OCP Catalog Node.

Runs the WSGI-free stdlib server in a background thread and asserts every
endpoint returns the required OCP shapes. This mirrors the TypeScript example's
schema test; here we assert the required keys structurally (no OCP pip package
exists yet).

    python conformance_test.py
"""
from __future__ import annotations

import json
from pathlib import Path
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer

import server

REQUIRED = {
    "manifest": {"ocp_version", "kind", "id", "catalog_id", "catalog_name", "endpoints", "query_capabilities", "object_contracts"},
    "health": {"ocp_version", "kind", "catalog_id", "status", "ready", "checked_at"},
    "query": {"ocp_version", "kind", "id", "catalog_id", "query", "result_count", "page", "entries"},
    "resolve": {"ocp_version", "kind", "id", "catalog_id", "entry_id", "commercial_object_id", "object_id", "object_type", "provider_id", "title", "visible_attributes", "action_bindings", "freshness", "expires_at"},
}


def _get(port: int, path: str):
    with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}") as resp:
        return resp.status, json.loads(resp.read().decode())


def _post(port: int, path: str, body: dict):
    return _post_raw(port, path, json.dumps(body))


def _post_raw(port: int, path: str, raw: str):
    data = raw.encode()
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}", data=data, headers={"content-type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read().decode())


class ConformanceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.shutdown()

    def test_manifest(self) -> None:
        status, body = _get(self.port, "/ocp/manifest")
        self.assertEqual(status, 200)
        self.assertLessEqual(REQUIRED["manifest"], set(body))
        self.assertEqual(body["object_contracts"], [])
        self.assertTrue(body["query_capabilities"])

    def test_health(self) -> None:
        status, body = _get(self.port, "/ocp/health")
        self.assertEqual(status, 200)
        self.assertLessEqual(REQUIRED["health"], set(body))
        self.assertTrue(body["ready"])

    def test_discovery(self) -> None:
        status, body = _get(self.port, "/.well-known/ocp-catalog")
        self.assertEqual(status, 200)
        self.assertIn("/ocp/query", body["query_url"])

    def test_query_keyword(self) -> None:
        status, body = _post(self.port, "/ocp/query", {"query": "headphones"})
        self.assertEqual(status, 200)
        self.assertLessEqual(REQUIRED["query"], set(body))
        self.assertEqual(body["result_count"], 1)
        self.assertEqual(body["page"]["offset"], 0)
        self.assertIn("Headphones", body["entries"][0]["entry"]["title"])

    def test_query_empty_returns_all(self) -> None:
        _, body = _post(self.port, "/ocp/query", {})
        self.assertEqual(body["result_count"], 3)

    def test_cursor_pagination(self) -> None:
        ids = []
        cursor = None
        for page_number in range(3):
            request = {"limit": 1}
            if cursor is not None:
                request["cursor"] = cursor
            status, body = _post(self.port, "/ocp/query", request)
            self.assertEqual(status, 200)
            self.assertEqual(body["result_count"], 1)
            self.assertEqual(body["page"]["offset"], 0)
            self.assertEqual(body["page"]["has_more"], page_number < 2)
            ids.append(body["entries"][0]["entry"]["entry_id"])
            cursor = body["page"].get("next_cursor")
        self.assertEqual(len(set(ids)), 3)
        self.assertIsNone(cursor)
        _, end = _post(self.port, "/ocp/query", {"limit": 1, "cursor": "999"})
        self.assertEqual(end["entries"], [])
        self.assertFalse(end["page"]["has_more"])

    def test_invalid_cursors(self) -> None:
        for cursor in ["-1", "1.5", "wrong", "9007199254740992", None, 1]:
            status, body = _post(self.port, "/ocp/query", {"limit": 1, "cursor": cursor})
            self.assertEqual(status, 400)
            self.assertEqual(body["error"]["code"], "invalid_request")

    def test_shared_query_conformance(self) -> None:
        fixture = json.loads((Path(__file__).resolve().parents[2] / "fixtures/query-conformance/cases.json").read_text(encoding="utf-8"))
        for example in fixture["cases"]:
            with self.subTest(example=example["name"]):
                if example.get("schema_valid"):
                    server._query_request(example["body"])
                self.assert_query_case(example)

    def test_shared_query_capability_semantics(self) -> None:
        fixture = json.loads((Path(__file__).resolve().parents[2] / "fixtures/query-conformance/semantics.json").read_text(encoding="utf-8"))
        _, manifest = _get(self.port, "/ocp/manifest")
        packs = [pack for capability in manifest["query_capabilities"] for pack in capability["query_packs"]]
        self.assertEqual([(pack["pack_id"], pack["query_modes"]) for pack in packs],
                         [(fixture["node_capability"]["query_pack"], fixture["node_capability"]["query_modes"])])
        filters = [field["name"][len("filters."):] for capability in manifest["query_capabilities"]
                   for field in capability.get("input_fields", []) if field["name"].startswith("filters.")]
        self.assertEqual(filters, fixture["node_capability"]["filter_fields"])
        for example in fixture["cases"]:
            with self.subTest(example=example["name"]):
                # Capability rejection must not be confused with invalid JSON/types.
                server._query_request(example["body"])
                self.assert_query_case(example)

    def assert_query_case(self, example: dict) -> None:
        raw = example.get("raw_body", json.dumps(example.get("body")))
        status, result = _post_raw(self.port, "/ocp/query", raw)
        self.assertEqual(status, example["status"])
        if status == 400:
            self.assertEqual(result["error"]["code"], "invalid_request")
            self.assertIsInstance(result["error"]["message"], str)
            self.assertTrue(result["error"]["message"])
            if "error_message" in example:
                self.assertEqual(result["error"]["message"], example["error_message"])
        else:
            self.assertLessEqual(REQUIRED["query"], set(result))
            self.assertIsInstance(result["query"], str)
            self.assertEqual(result["query_pack"], "ocp.query.keyword.v1")
            self.assertEqual(result["query_mode"], "keyword")
            self.assertEqual(result["result_count"], example["result_count"])
            self.assertEqual(result["page"]["limit"], example["page_limit"])
            self.assertEqual(result["page"]["offset"], 0)
            self.assertIsInstance(result["page"]["has_more"], bool)
            if "entry_ids" in example:
                self.assertEqual([item["entry"]["entry_id"] for item in result["entries"]], example["entry_ids"])

    def test_resolve(self) -> None:
        status, body = _post(self.port, "/ocp/resolve", {"entry_id": "entry_example_inmemory_sku-001"})
        self.assertEqual(status, 200)
        self.assertLessEqual(REQUIRED["resolve"], set(body))
        self.assertEqual(body["action_bindings"][0]["action_type"], "url")

    def test_resolve_unknown_404(self) -> None:
        status, _ = _post(self.port, "/ocp/resolve", {"entry_id": "entry_example_inmemory_nope"})
        self.assertEqual(status, 404)


if __name__ == "__main__":
    unittest.main()
