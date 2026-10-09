/**
 * A minimal, spec-valid OCP Catalog Node in TypeScript.
 *
 * Serves five endpoints from ~3 in-memory products, with no database, no
 * vendor client, and no auth. It is the smallest thing that answers the OCP
 * Catalog read surface:
 *
 *   GET  /.well-known/ocp-catalog   discovery
 *   GET  /ocp/manifest              capabilities
 *   GET  /ocp/health                liveness
 *   GET  /ocp/contracts             object contracts (empty — read-only node)
 *   POST /ocp/query                 keyword search over products
 *   POST /ocp/resolve               resolve one entry into actions
 *
 * The response shapes match @ocp-catalog/ocp-schema; see server.test.ts, which
 * parses every response through those schemas to prove conformance.
 */
import { catalogQueryRequestSchema, type CatalogQueryRequest } from '@ocp-catalog/ocp-schema';
import { PRODUCTS, type Product } from './products';

const CATALOG_ID = process.env.CATALOG_ID ?? 'cat_example_typescript';
const CATALOG_NAME = process.env.CATALOG_NAME ?? 'Example TypeScript Catalog';
const PROVIDER_ID = 'example_inmemory';
const QUERY_PACK = 'ocp.query.keyword.v1';
const QUERY_MODE = 'keyword';
const PORT = Number(process.env.PORT ?? 4400);
const BASE_URL = (process.env.PUBLIC_BASE_URL ?? `http://localhost:${PORT}`).replace(/\/$/, '');

const entryId = (product: Product) => `entry_${PROVIDER_ID}_${product.id}`;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function wellKnownDiscovery() {
  return {
    ocp_version: '1.0',
    kind: 'WellKnownCatalogDiscovery',
    catalog_id: CATALOG_ID,
    catalog_name: CATALOG_NAME,
    manifest_url: `${BASE_URL}/ocp/manifest`,
    health_url: `${BASE_URL}/ocp/health`,
    query_url: `${BASE_URL}/ocp/query`,
    resolve_url: `${BASE_URL}/ocp/resolve`,
    contracts_url: `${BASE_URL}/ocp/contracts`,
  };
}

function manifest() {
  return {
    ocp_version: '1.0',
    kind: 'CatalogManifest',
    id: `manifest_${CATALOG_ID}`,
    catalog_id: CATALOG_ID,
    catalog_name: CATALOG_NAME,
    description: 'Minimal in-memory OCP Catalog Node example (TypeScript).',
    registry_visibility: 'public',
    endpoints: {
      health: { url: `${BASE_URL}/ocp/health`, method: 'GET' },
      query: { url: `${BASE_URL}/ocp/query`, method: 'POST' },
      resolve: { url: `${BASE_URL}/ocp/resolve`, method: 'POST' },
      contracts: { url: `${BASE_URL}/ocp/contracts`, method: 'GET' },
    },
    query_capabilities: [
      {
        capability_id: 'ocp.example.product.search.v1',
        name: 'Keyword product search',
        description: 'Case-insensitive keyword match over the in-memory product list.',
        query_packs: [
          {
            pack_id: QUERY_PACK,
            description: 'Keyword search over title, summary, brand, and category.',
            query_modes: [QUERY_MODE],
          },
        ],
        supports_explain: true,
        supports_resolve: true,
      },
    ],
    // Required by the schema even for a read-only node that ingests nothing.
    object_contracts: [],
  };
}

function health() {
  return {
    ocp_version: '1.0',
    kind: 'CatalogHealth',
    catalog_id: CATALOG_ID,
    status: 'healthy',
    ready: true,
    checked_at: new Date().toISOString(),
  };
}

function contracts() {
  return {
    ocp_version: '1.0',
    kind: 'ObjectContractList',
    catalog_id: CATALOG_ID,
    object_contracts: [],
    note: 'Read-only example node; it does not accept provider object ingestion.',
  };
}

function toEntry(product: Product) {
  return {
    kind: 'CatalogEntry',
    catalog_id: CATALOG_ID,
    entry_id: entryId(product),
    provider_id: PROVIDER_ID,
    object_id: product.id,
    object_type: 'ocp.commerce.product',
    title: product.title,
    summary: product.summary,
    attributes: {
      brand: product.brand,
      category: product.category,
      price: { currency: product.currency, amount: product.amount },
      inventory: { availability_status: product.availability },
      product_url: product.url,
    },
  };
}

function query(body: CatalogQueryRequest): Response {
  // Protocol-valid fields must also fit this node's declared capability.
  // An omitted mode retains the example's keyword/list-all default.
  if (body.query_pack !== undefined && body.query_pack !== QUERY_PACK) {
    return json({ error: { code: 'invalid_request', message: `unsupported query_pack: only ${QUERY_PACK} is supported` } }, 400);
  }
  if (body.query_mode !== undefined && body.query_mode !== QUERY_MODE) {
    return json({ error: { code: 'invalid_request', message: `unsupported query_mode: only ${QUERY_MODE} is supported` } }, 400);
  }
  if (Object.keys(body.filters).length > 0) {
    return json({ error: { code: 'invalid_request', message: 'unsupported filters: this keyword node does not support filter fields' } }, 400);
  }
  const rawCursor = body.cursor === undefined ? '0' : body.cursor;
  if (typeof rawCursor !== 'string' || !/^\d+$/.test(rawCursor) || !Number.isSafeInteger(Number(rawCursor))) {
    return json({ error: { code: 'invalid_request', message: 'cursor must be a non-negative decimal integer string' } }, 400);
  }
  const offset = Number(rawCursor);
  const term = body.query.trim().toLowerCase();
  const limit = body.limit;
  const matches = term
    ? PRODUCTS.filter((p) =>
        [p.title, p.summary, p.brand, p.category].some((f) => f.toLowerCase().includes(term)),
      )
    : PRODUCTS;
  const page = matches.slice(offset, offset + limit);
  const hasMore = offset + page.length < matches.length;
  return json({
    ocp_version: '1.0',
    kind: 'CatalogQueryResult',
    id: `qry_${crypto.randomUUID()}`,
    catalog_id: CATALOG_ID,
    query_pack: QUERY_PACK,
    query_mode: QUERY_MODE,
    query: body.query ?? '',
    result_count: page.length,
    page: { limit, offset: 0, has_more: hasMore, ...(hasMore ? { next_cursor: String(offset + page.length) } : {}) },
    entries: page.map((product) => ({
      entry: toEntry(product),
      score: 1,
      explain: [`Keyword match for "${body.query ?? ''}".`],
    })),
  });
}

function resolve(body: { entry_id?: string }) {
  const product = PRODUCTS.find((p) => entryId(p) === body.entry_id);
  if (!product) {
    return json(
      { error: { code: 'not_found', message: `Unknown entry_id: ${body.entry_id ?? '(missing)'}` } },
      404,
    );
  }
  const now = new Date().toISOString();
  return json({
    ocp_version: '1.0',
    kind: 'ResolvableReference',
    id: `res_${crypto.randomUUID()}`,
    catalog_id: CATALOG_ID,
    entry_id: entryId(product),
    commercial_object_id: `co_${product.id}`,
    object_id: product.id,
    object_type: 'ocp.commerce.product',
    provider_id: PROVIDER_ID,
    title: product.title,
    visible_attributes: {
      brand: product.brand,
      category: product.category,
      price: { currency: product.currency, amount: product.amount },
      availability: product.availability,
    },
    action_bindings: [
      {
        action_id: 'view',
        action_type: 'url',
        label: 'View product',
        entrypoint: { url: product.url, method: 'GET' },
      },
    ],
    freshness: { object_updated_at: product.updated_at, resolved_at: now },
    // Resolutions are short-lived; expire in one hour.
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('request body must be a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error('request body must be a valid JSON object');
  }
}

export async function handle(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  const { method } = request;

  if (method === 'GET' && pathname === '/.well-known/ocp-catalog') return json(wellKnownDiscovery());
  if (method === 'GET' && pathname === '/ocp/manifest') return json(manifest());
  if (method === 'GET' && pathname === '/ocp/health') return json(health());
  if (method === 'GET' && pathname === '/ocp/contracts') return json(contracts());
  if (method === 'POST' && (pathname === '/ocp/query' || pathname === '/ocp/resolve')) {
    let body: Record<string, unknown>;
    try { body = await readJson(request); }
    catch (error) {
      return json({ error: { code: 'invalid_request', message: (error as Error).message } }, 400);
    }
    if (pathname === '/ocp/query') {
      const parsed = catalogQueryRequestSchema.safeParse(body);
      if (!parsed.success) {
        return json({ error: { code: 'invalid_request', message: 'invalid catalog query request' } }, 400);
      }
      return query(parsed.data);
    }
    return resolve(body);
  }

  return json({ error: { code: 'not_found', message: `No route for ${method} ${pathname}` } }, 404);
}

// Start the server unless imported by a test.
if (import.meta.main) {
  Bun.serve({ port: PORT, fetch: handle });
  console.log(`Example TypeScript OCP Catalog Node listening on ${BASE_URL}`);
}
