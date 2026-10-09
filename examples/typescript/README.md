# Minimal OCP Catalog Node — TypeScript

The smallest spec-valid [OCP Catalog Node](../../docs/specs), serving three
hardcoded in-memory products. No database, no vendor API, no auth.

## Run

```bash
bun install
bun run start        # listens on http://localhost:4400
```

Then:

```bash
curl http://localhost:4400/ocp/manifest
curl http://localhost:4400/ocp/health
curl -X POST http://localhost:4400/ocp/query   -H 'content-type: application/json' -d '{"query":"headphones"}'
curl -X POST http://localhost:4400/ocp/resolve -H 'content-type: application/json' -d '{"entry_id":"entry_example_inmemory_sku-001"}'
```

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/.well-known/ocp-catalog` | discovery |
| GET | `/ocp/manifest` | capabilities + query packs |
| GET | `/ocp/health` | liveness |
| GET | `/ocp/contracts` | object contracts (empty — read-only node) |
| POST | `/ocp/query` | keyword search over products |
| POST | `/ocp/resolve` | resolve one entry into action bindings |

## Query support

The node implements `ocp.query.keyword.v1` and mode `keyword`, with no filter
input fields. Omitted pack/mode select these defaults; an empty query lists all
products and `filters: {}` is accepted. Other packs, other protocol modes, or
any nonempty filters return HTTP 400 with `error.code: "invalid_request"`.
A field being valid in the protocol schema does not mean this node supports it.

The SDK infers `filter` for an empty query when mode is omitted. SDK callers
should use explicit `query_mode: "keyword"` to list all products. See the
[shared conformance matrices](../../fixtures/query-conformance) for this
documented default difference and the capability rejection cases.

## Conformance

`src/server.test.ts` parses every response through the published
[`@ocp-catalog/ocp-schema`](https://www.npmjs.com/package/@ocp-catalog/ocp-schema)
Zod schemas, so the example is provably spec-valid:

```bash
bun test
```

Configuration via env: `CATALOG_ID`, `CATALOG_NAME`, `PORT`, `PUBLIC_BASE_URL`.
