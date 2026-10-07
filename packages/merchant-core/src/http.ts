/**
 * The HTTP surface: response helpers and the OCP read endpoints.
 *
 * Two conventions from the existing repo are load-bearing here.
 *
 * First, the status code carries meaning, and `OcpClient` branches on it before
 * it looks at the body. So a success is always 2xx with a schema-correct JSON
 * body, and every failure is non-2xx with the `{ error: { code, message } }`
 * envelope. An error smuggled into a 200 body is invisible to the client.
 *
 * Second, every response is parsed through the protocol's own schema before it
 * goes out. That is not belt-and-braces: the manifest, query result and
 * resolution are all read by a caller that validates them, and a field this
 * server emits but the schema rejects would fail on A's side with no clue where
 * it came from. Parsing here turns that into a loud local failure.
 */
import { randomUUID } from 'node:crypto';
import {
  catalogManifestSchema,
  catalogQueryRequestSchema,
  catalogQueryResultSchema,
  catalogHealthResponseSchema,
  resolvableReferenceSchema,
  resolveRequestSchema,
  type CatalogManifest,
  type CatalogQueryResult,
  type CatalogHealthResponse,
  type ResolvableReference,
} from '@ocp-catalog/ocp-schema';
import { CommerceError, EXPECTED_FILTERABLE_FIELD_REFS } from '@ocp-catalog/shopping-contracts';
import type { MerchantContext } from './context';
import {
  buildResolvableReference,
  explainEntry,
  findEntry,
  runCatalogQuery,
  scoreEntry,
  UNIMPLEMENTED_QUERY_FILTER_KEYS,
} from './catalog';

/** The query capability and pack this merchant implements. Declared once. */
export const CAPABILITY_ID = 'ocp.demo.coffee.search.v1';
export const QUERY_PACK_ID = 'ocp.query.keyword.v1';

/** Field refs the keyword search looks at. Mirrors `searchableText` in catalog.ts. */
const SEARCHABLE_FIELD_REFS = ['product.core#/title', 'product.core#/brand', 'product.core#/category'] as const;

export const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

export function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': JSON_CONTENT_TYPE, ...(headers ?? {}) },
  });
}

/** Renders a commerce error with the status its code mandates. */
export function errorResponse(error: CommerceError, headers?: HeadersInit): Response {
  return jsonResponse(error.toResponse(), error.status, headers);
}

/**
 * Renders anything thrown by a route.
 *
 * An unexpected error becomes a bare 500 with no envelope. That is deliberate:
 * there is no error code in the fixed set that means "the merchant broke", and
 * inventing one would tell the caller to act on a condition it cannot act on.
 * A 500 that carries no structured body cannot be mistaken for a business
 * answer.
 */
export function unexpectedErrorResponse(cause: unknown): Response {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new Response(`internal error: ${message}`, { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new CommerceError('invalid_request', 'the request body is not valid JSON');
  }
}

/* -------------------------------------------------------------- OCP reading */

export function handleDiscovery(ctx: MerchantContext): Response {
  const { config } = ctx;
  return jsonResponse({
    ocp_version: '1.0',
    kind: 'WellKnownCatalogDiscovery',
    catalog_id: config.catalogId,
    catalog_name: config.catalogName,
    manifest_url: `${config.publicBaseUrl}/ocp/manifest`,
    health_url: `${config.publicBaseUrl}/ocp/health`,
    query_url: `${config.publicBaseUrl}/ocp/query`,
    resolve_url: `${config.publicBaseUrl}/ocp/resolve`,
  });
}

/**
 * The manifest.
 *
 * `filterable_field_refs` is derived from `COFFEE_FILTER_MAP` rather than typed
 * out, so the declaration and the implementation are the same object. That is
 * what makes "the declared filters actually work" checkable: there is no second
 * list to drift from the first.
 */
export function handleManifest(ctx: MerchantContext): Response {
  const { config, catalog } = ctx;
  const manifest: CatalogManifest = catalogManifestSchema.parse({
    ocp_version: '1.0',
    kind: 'CatalogManifest',
    id: `manifest_${config.catalogId}`,
    catalog_id: config.catalogId,
    catalog_name: config.catalogName,
    description: '本地演示咖啡店。付款为本地模拟，不接任何真实支付。',
    registry_visibility: 'public',
    endpoints: {
      health: { url: `${config.publicBaseUrl}/ocp/health`, method: 'GET' },
      query: { url: `${config.publicBaseUrl}/ocp/query`, method: 'POST' },
      resolve: { url: `${config.publicBaseUrl}/ocp/resolve`, method: 'POST' },
    },
    query_capabilities: [
      {
        capability_id: CAPABILITY_ID,
        name: 'Coffee catalog keyword search',
        description: 'Case-insensitive keyword match over title, summary, brand and category.',
        query_packs: [
          {
            pack_id: QUERY_PACK_ID,
            description: 'Keyword search with optional filters.',
            query_modes: ['keyword'],
          },
        ],
        searchable_field_refs: [...SEARCHABLE_FIELD_REFS],
        filterable_field_refs: [...EXPECTED_FILTERABLE_FIELD_REFS],
        sortable_field_refs: [],
        supports_explain: true,
        supports_resolve: true,
      },
    ],
    data_profile: {
      catalog_entry_count: catalog.length,
      object_counts: [{ object_type: 'ocp.commerce.product', count: catalog.length }],
    },
    // Required by the schema even for a node that ingests nothing.
    object_contracts: [],
  });
  return jsonResponse(manifest);
}

export function handleHealth(ctx: MerchantContext): Response {
  const { config, clock } = ctx;
  const health: CatalogHealthResponse = catalogHealthResponseSchema.parse({
    ocp_version: '1.0',
    kind: 'CatalogHealth',
    catalog_id: config.catalogId,
    status: 'healthy',
    ready: true,
    checked_at: new Date(clock.nowMs()).toISOString(),
  });
  return jsonResponse(health);
}

export function handleQuery(ctx: MerchantContext, rawBody: unknown): Response {
  const request = catalogQueryRequestSchema.safeParse(rawBody);
  if (!request.success) {
    throw new CommerceError('invalid_request', `invalid query request: ${request.error.message}`);
  }

  const outcome = runCatalogQuery(ctx.catalog, request.data);
  const term = request.data.query;

  const result: CatalogQueryResult = catalogQueryResultSchema.parse({
    ocp_version: '1.0',
    kind: 'CatalogQueryResult',
    id: `qry_${randomUUID()}`,
    catalog_id: ctx.config.catalogId,
    query_pack: QUERY_PACK_ID,
    query_mode: 'keyword',
    query: term,
    result_count: outcome.matches.length,
    page: {
      limit: outcome.limit,
      // The protocol fixes `offset` at the literal 0, so a cursor's position
      // cannot be reported here. Where the page actually starts is carried by
      // `next_cursor` alone; writing the true offset would fail the schema.
      offset: 0,
      has_more: outcome.hasMore,
      ...(outcome.nextCursor === undefined ? {} : { next_cursor: outcome.nextCursor }),
    },
    entries: outcome.matches.map((record) => ({
      entry: record.entry,
      score: scoreEntry(record, term),
      explain: explainEntry(record, term),
    })),
    policy_summary: {
      selected_capability_id: CAPABILITY_ID,
      selected_query_pack: QUERY_PACK_ID,
      query_mode: 'keyword',
      supports_explain: true,
      accepted_filters: [...outcome.acceptedFilters],
      rejected_filters: [...outcome.rejectedFilters],
      warnings:
        outcome.rejectedFilters.length === 0
          ? []
          : [
              `These filters are valid in the protocol but not implemented by this merchant and were NOT applied: ${outcome.rejectedFilters.join(', ')}. A filter this merchant does not implement is ${UNIMPLEMENTED_QUERY_FILTER_KEYS.join(', ')}.`,
            ],
    },
    explain: [],
  });

  return jsonResponse(result);
}

export function handleResolve(ctx: MerchantContext, rawBody: unknown): Response {
  const request = resolveRequestSchema.safeParse(rawBody);
  if (!request.success) {
    throw new CommerceError('invalid_request', `invalid resolve request: ${request.error.message}`);
  }

  const record = findEntry(ctx.catalog, request.data.entry_id);
  if (record === null) {
    throw new CommerceError('not_found', `unknown entry_id: ${request.data.entry_id}`);
  }

  const reference: ResolvableReference = resolvableReferenceSchema.parse(
    buildResolvableReference(record, { config: ctx.config, nowMs: ctx.clock.nowMs() }),
  );
  return jsonResponse(reference);
}
