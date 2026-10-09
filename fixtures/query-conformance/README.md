# Reference-node query conformance

`cases.json` and `semantics.json` are consumed by the TypeScript, Python, and Go
reference-node tests. The first matrix covers protocol field types, strict
request/filter shapes, integer page-size bounds, Unicode query-length bounds,
malformed/non-object JSON, and decimal cursor pagination. Cases marked
`schema_valid` distinguish a valid protocol shape from unsupported node
capabilities. The TypeScript tests also validate every successful request and
response with `@ocp-catalog/ocp-schema`.

Every body in `semantics.json` is protocol-schema valid. The three nodes assert
that their manifests declare exactly `ocp.query.keyword.v1`, mode `keyword`,
and no filter input fields, then exercise the same bodies through HTTP. Unknown
packs, other protocol modes, and every nonempty filter object return HTTP 400;
false boolean filters and zero amount bounds still request filter fields. Error
messages are checked across languages. Empty filters and ordinary keyword
search retain their existing results.

The TypeScript test additionally calls `validateCatalogQueryRequest` against
the actual manifest. `sdk_error` records the expected SDK rejection code; its
absence means validation succeeds. Two deliberate compatibility cases retain
the nodes' historical empty-query/list-all default when `query_mode` is omitted.
The SDK currently infers `filter` for an empty query and rejects that inferred
mode against these keyword-only manifests; these cases therefore expect SDK
`invalid_query_mode` and node HTTP 200. SDK callers can send explicit
`query_mode: "keyword"` to list all products. The repository protocol contract
makes the mode optional and associates allowed modes with a pack; it does not
specify the SDK's inference as a mandatory node default.

Each case supplies `body` or an exact `raw_body`, an expected HTTP `status`, and
successful-page expectations. Invalid requests must return a nonempty structured
`error` with code `invalid_request` and HTTP 400. This example's cursor format is
a non-negative decimal integer no larger than JavaScript's safe-integer maximum;
the protocol itself treats cursors as opaque strings.

Run from the repository root with the pinned Bun version:

```text
bun test examples/typescript/src
```

Run the standard-library checks from their example directories:

```text
cd examples/python
python conformance_test.py
```

```text
cd examples/go
go test ./...
```

These examples remain small read-only keyword-search nodes. Protocol support
for filter field shapes and modes does not advertise their implementation by
every node. Additional query packs or filters must be implemented and declared
in the node manifest before accepting them.
