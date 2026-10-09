"""A minimal, spec-valid OCP Catalog Node in Python (standard library only).

Serves five endpoints from ~3 in-memory products, with no database, no vendor
client, and no third-party dependencies. It answers the OCP Catalog read
surface:

    GET  /.well-known/ocp-catalog   discovery
    GET  /ocp/manifest              capabilities
    GET  /ocp/health                liveness
    GET  /ocp/contracts             object contracts (empty -- read-only node)
    POST /ocp/query                 keyword search over products
    POST /ocp/resolve               resolve one entry into actions

Response shapes match @ocp-catalog/ocp-schema. Run `python conformance_test.py`
after starting the server to check them.
"""
from __future__ import annotations

import json
import math
import os
import re
import uuid
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CATALOG_ID = os.environ.get("CATALOG_ID", "cat_example_python")
CATALOG_NAME = os.environ.get("CATALOG_NAME", "Example Python Catalog")
PROVIDER_ID = "example_inmemory"
QUERY_PACK = "ocp.query.keyword.v1"
QUERY_MODE = "keyword"
PORT = int(os.environ.get("PORT", "4401"))
BASE_URL = os.environ.get("PUBLIC_BASE_URL", f"http://localhost:{PORT}").rstrip("/")

PRODUCTS = [
    {
        "id": "sku-001",
        "title": "Aurora Wireless Headphones",
        "summary": "Over-ear Bluetooth headphones with active noise cancellation.",
        "brand": "Aurora",
        "category": "electronics",
        "currency": "USD",
        "amount": 199.0,
        "availability": "in_stock",
        "url": "https://example.com/products/aurora-headphones",
        "updated_at": "2026-07-01T00:00:00.000Z",
    },
    {
        "id": "sku-002",
        "title": "Trailhead Running Shoes",
        "summary": "Lightweight trail runners with a grippy all-terrain outsole.",
        "brand": "Trailhead",
        "category": "footwear",
        "currency": "USD",
        "amount": 129.0,
        "availability": "low_stock",
        "url": "https://example.com/products/trailhead-shoes",
        "updated_at": "2026-07-02T00:00:00.000Z",
    },
    {
        "id": "sku-003",
        "title": "Camp Kettle 1.5L",
        "summary": "Hard-anodized aluminium kettle for backcountry cooking.",
        "brand": "Basecamp",
        "category": "outdoors",
        "currency": "USD",
        "amount": 39.0,
        "availability": "in_stock",
        "url": "https://example.com/products/camp-kettle",
        "updated_at": "2026-07-03T00:00:00.000Z",
    },
]


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def _entry_id(product: dict) -> str:
    return f"entry_{PROVIDER_ID}_{product['id']}"


def well_known_discovery() -> dict:
    return {
        "ocp_version": "1.0",
        "kind": "WellKnownCatalogDiscovery",
        "catalog_id": CATALOG_ID,
        "catalog_name": CATALOG_NAME,
        "manifest_url": f"{BASE_URL}/ocp/manifest",
        "health_url": f"{BASE_URL}/ocp/health",
        "query_url": f"{BASE_URL}/ocp/query",
        "resolve_url": f"{BASE_URL}/ocp/resolve",
        "contracts_url": f"{BASE_URL}/ocp/contracts",
    }


def manifest() -> dict:
    return {
        "ocp_version": "1.0",
        "kind": "CatalogManifest",
        "id": f"manifest_{CATALOG_ID}",
        "catalog_id": CATALOG_ID,
        "catalog_name": CATALOG_NAME,
        "description": "Minimal in-memory OCP Catalog Node example (Python).",
        "registry_visibility": "public",
        "endpoints": {
            "health": {"url": f"{BASE_URL}/ocp/health", "method": "GET"},
            "query": {"url": f"{BASE_URL}/ocp/query", "method": "POST"},
            "resolve": {"url": f"{BASE_URL}/ocp/resolve", "method": "POST"},
            "contracts": {"url": f"{BASE_URL}/ocp/contracts", "method": "GET"},
        },
        "query_capabilities": [
            {
                "capability_id": "ocp.example.product.search.v1",
                "name": "Keyword product search",
                "description": "Case-insensitive keyword match over the in-memory product list.",
                "query_packs": [
                    {
                        "pack_id": QUERY_PACK,
                        "description": "Keyword search over title, summary, brand, and category.",
                        "query_modes": [QUERY_MODE],
                    }
                ],
                "supports_explain": True,
                "supports_resolve": True,
            }
        ],
        # Required by the schema even for a read-only node that ingests nothing.
        "object_contracts": [],
    }


def health() -> dict:
    return {
        "ocp_version": "1.0",
        "kind": "CatalogHealth",
        "catalog_id": CATALOG_ID,
        "status": "healthy",
        "ready": True,
        "checked_at": _now(),
    }


def contracts() -> dict:
    return {
        "ocp_version": "1.0",
        "kind": "ObjectContractList",
        "catalog_id": CATALOG_ID,
        "object_contracts": [],
        "note": "Read-only example node; it does not accept provider object ingestion.",
    }


def _to_entry(product: dict) -> dict:
    return {
        "kind": "CatalogEntry",
        "catalog_id": CATALOG_ID,
        "entry_id": _entry_id(product),
        "provider_id": PROVIDER_ID,
        "object_id": product["id"],
        "object_type": "ocp.commerce.product",
        "title": product["title"],
        "summary": product["summary"],
        "attributes": {
            "brand": product["brand"],
            "category": product["category"],
            "price": {"currency": product["currency"], "amount": product["amount"]},
            "inventory": {"availability_status": product["availability"]},
            "product_url": product["url"],
        },
    }


def _finite_number(value) -> bool:
    return (type(value) is int and abs(value) <= 1.7976931348623157e308) or (type(value) is float and math.isfinite(value))


def _query_request(body: dict) -> dict:
    """Mirror catalogQueryRequestSchema; shared fixtures catch language drift."""
    fields = {"ocp_version", "kind", "catalog_id", "query_pack", "query_mode", "query",
              "filters", "limit", "offset", "cursor", "explain"}
    if not isinstance(body, dict) or set(body) - fields:
        raise ValueError("invalid catalog query request")
    for field, allowed in (("ocp_version", {"1.0"}), ("kind", {"CatalogQueryRequest"}),
                           ("query_mode", {"keyword", "filter", "semantic", "hybrid"})):
        if field in body and (not isinstance(body[field], str) or body[field] not in allowed):
            raise ValueError("invalid catalog query request")
    for field in ("catalog_id", "query_pack", "cursor"):
        if field in body and (not isinstance(body[field], str) or not body[field]):
            raise ValueError("invalid catalog query request")
    text = body.get("query", "")
    # The shared schema measures string lengths in Unicode code points.
    if not isinstance(text, str) or len(text) > 500:
        raise ValueError("query must be a string of at most 500 characters")
    if "cursor" in body and len(body["cursor"]) > 512:
        raise ValueError("invalid catalog query request")
    limit = body.get("limit", 20)
    if not _finite_number(limit) or not 1 <= limit <= 50 or limit != int(limit):
        raise ValueError("limit must be an integer between 1 and 50")
    offset = body.get("offset", 0)
    if type(offset) not in (int, float) or offset != 0:
        raise ValueError("offset must be zero; use cursor pagination")
    if "explain" in body and not isinstance(body["explain"], bool):
        raise ValueError("explain must be a boolean")
    filters = body.get("filters", {})
    string_filters = {"category", "brand", "currency", "availability_status", "provider_id", "sku"}
    number_filters = {"min_amount", "max_amount"}
    bool_filters = {"in_stock_only", "has_image"}
    if not isinstance(filters, dict) or set(filters) - (string_filters | number_filters | bool_filters):
        raise ValueError("invalid catalog query filters")
    for field, value in filters.items():
        if ((field in string_filters and (not isinstance(value, str) or not value))
                or (field in number_filters and (not _finite_number(value) or value < 0))
                or (field in bool_filters and not isinstance(value, bool))):
            raise ValueError("invalid catalog query filters")
    return {**body, "query": text, "limit": int(limit)}


def _query_capability(body: dict) -> None:
    """Check manifest support after protocol shape validation."""
    if body.get("query_pack", QUERY_PACK) != QUERY_PACK:
        raise ValueError(f"unsupported query_pack: only {QUERY_PACK} is supported")
    # Preserve the example's keyword/list-all default when mode is omitted.
    if body.get("query_mode", QUERY_MODE) != QUERY_MODE:
        raise ValueError(f"unsupported query_mode: only {QUERY_MODE} is supported")
    if body.get("filters", {}):
        raise ValueError("unsupported filters: this keyword node does not support filter fields")


def query(body: dict) -> dict:
    body = _query_request(body)
    _query_capability(body)
    cursor = body.get("cursor", "0")
    if not re.fullmatch(r"[0-9]+", cursor) or int(cursor) > 9007199254740991:
        raise ValueError("cursor must be a non-negative decimal integer string")
    offset = int(cursor)
    term = body["query"].strip().lower()
    limit = body["limit"]
    if term:
        matches = [
            p
            for p in PRODUCTS
            if any(term in str(p[f]).lower() for f in ("title", "summary", "brand", "category"))
        ]
    else:
        matches = list(PRODUCTS)
    page = matches[offset:offset + limit]
    has_more = offset + len(page) < len(matches)
    return {
        "ocp_version": "1.0",
        "kind": "CatalogQueryResult",
        "id": f"qry_{uuid.uuid4()}",
        "catalog_id": CATALOG_ID,
        "query_pack": QUERY_PACK,
        "query_mode": QUERY_MODE,
        "query": body.get("query", "") or "",
        "result_count": len(page),
        "page": {"limit": limit, "offset": 0, "has_more": has_more,
                 **({"next_cursor": str(offset + len(page))} if has_more else {})},
        "entries": [
            {"entry": _to_entry(p), "score": 1, "explain": [f"Keyword match for \"{body.get('query', '')}\"."]}
            for p in page
        ],
    }


def resolve(body: dict):
    entry_id = body.get("entry_id")
    product = next((p for p in PRODUCTS if _entry_id(p) == entry_id), None)
    if product is None:
        return 404, {
            "error": {"code": "not_found", "message": f"Unknown entry_id: {entry_id or '(missing)'}"}
        }
    now = _now()
    expires = (datetime.now(timezone.utc) + timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    return 200, {
        "ocp_version": "1.0",
        "kind": "ResolvableReference",
        "id": f"res_{uuid.uuid4()}",
        "catalog_id": CATALOG_ID,
        "entry_id": _entry_id(product),
        "commercial_object_id": f"co_{product['id']}",
        "object_id": product["id"],
        "object_type": "ocp.commerce.product",
        "provider_id": PROVIDER_ID,
        "title": product["title"],
        "visible_attributes": {
            "brand": product["brand"],
            "category": product["category"],
            "price": {"currency": product["currency"], "amount": product["amount"]},
            "availability": product["availability"],
        },
        "action_bindings": [
            {
                "action_id": "view",
                "action_type": "url",
                "label": "View product",
                "entrypoint": {"url": product["url"], "method": "GET"},
            }
        ],
        "freshness": {"object_updated_at": product["updated_at"], "resolved_at": now},
        "expires_at": expires,
    }


class Handler(BaseHTTPRequestHandler):
    def _send(self, status: int, payload: dict) -> None:
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _read_json(self) -> dict:
        length = int(self.headers.get("content-length", 0) or 0)
        if not length:
            raise ValueError("request body must be a valid JSON object")
        try:
            def reject_constant(_value):
                raise ValueError("invalid JSON number")
            parsed = json.loads(self.rfile.read(length).decode("utf-8"), parse_constant=reject_constant)
            if not isinstance(parsed, dict):
                raise ValueError("request body must be a JSON object")
            return parsed
        except (ValueError, UnicodeDecodeError):
            raise ValueError("request body must be a valid JSON object") from None

    def do_GET(self) -> None:  # noqa: N802 (http.server API)
        routes = {
            "/.well-known/ocp-catalog": well_known_discovery,
            "/ocp/manifest": manifest,
            "/ocp/health": health,
            "/ocp/contracts": contracts,
        }
        builder = routes.get(self.path)
        if builder is None:
            self._send(404, {"error": {"code": "not_found", "message": f"No route for GET {self.path}"}})
            return
        self._send(200, builder())

    def do_POST(self) -> None:  # noqa: N802 (http.server API)
        if self.path == "/ocp/query":
            try:
                result = query(self._read_json())
            except (ValueError, TypeError) as exc:
                self._send(400, {"error": {"code": "invalid_request", "message": str(exc)}})
                return
            self._send(200, result)
            return
        if self.path == "/ocp/resolve":
            try:
                status, payload = resolve(self._read_json())
            except ValueError as exc:
                self._send(400, {"error": {"code": "invalid_request", "message": str(exc)}})
                return
            self._send(status, payload)
            return
        self._send(404, {"error": {"code": "not_found", "message": f"No route for POST {self.path}"}})

    def log_message(self, *_args) -> None:  # silence default request logging
        return


def main() -> None:
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"Example Python OCP Catalog Node listening on {BASE_URL}")
    server.serve_forever()


if __name__ == "__main__":
    main()
