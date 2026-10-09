import { describe, expect, test } from 'bun:test';
import {
  catalogHealthResponseSchema,
  catalogManifestSchema,
  catalogQueryModeSchema,
  catalogQueryRequestSchema,
  catalogQueryResultSchema,
  resolvableReferenceSchema,
} from '@ocp-catalog/ocp-schema';
import { handle } from './server';
// Compare the repository SDK policy with the same fixtures used by all nodes.
import { OcpClientValidationError, validateCatalogQueryRequest } from '../../../packages/ocp-client/src/index';

interface QueryCase {
  name: string;
  body?: unknown;
  raw_body?: string;
  status: number;
  result_count?: number;
  page_limit?: number;
  entry_ids?: string[];
  schema_valid?: boolean;
  sdk_error?: string;
  error_message?: string;
}
const fixture: { cases: QueryCase[] } = await Bun.file(new URL('../../../fixtures/query-conformance/cases.json', import.meta.url)).json();
const semanticFixture: {
  node_capability: { query_pack: string; query_modes: string[]; filter_fields: string[] };
  cases: QueryCase[];
} = await Bun.file(new URL('../../../fixtures/query-conformance/semantics.json', import.meta.url)).json();

async function assertQueryCase(example: QueryCase) {
  const raw = example.raw_body ?? JSON.stringify(example.body);
  if (example.schema_valid) catalogQueryRequestSchema.parse(JSON.parse(raw));
  const response = await handle(new Request('http://localhost/ocp/query', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: raw,
  }));
  expect(response.status).toBe(example.status);
  const result: any = await response.json();
  if (example.status === 400) {
    expect(result.error.code).toBe('invalid_request');
    expect(typeof result.error.message).toBe('string');
    expect(result.error.message.length).toBeGreaterThan(0);
    if (example.error_message) expect(result.error.message).toBe(example.error_message);
  } else {
    catalogQueryRequestSchema.parse(JSON.parse(raw));
    const parsed = catalogQueryResultSchema.parse(result);
    expect(parsed.query_pack).toBe(semanticFixture.node_capability.query_pack);
    expect(parsed.query_mode).toBe('keyword');
    expect(parsed.result_count).toBe(example.result_count!);
    expect(parsed.page.limit).toBe(example.page_limit!);
    if (example.entry_ids) expect(parsed.entries.map(item => item.entry.entry_id)).toEqual(example.entry_ids);
  }
}

describe('shared query request conformance', () => {
  for (const example of fixture.cases) {
    test(example.name, () => assertQueryCase(example));
  }
});

describe('shared query capability semantics', () => {
  test('manifest declares exactly the capability checked by the matrix', async () => {
    const manifest = catalogManifestSchema.parse(await (await handle(new Request('http://localhost/ocp/manifest'))).json());
    const packs = manifest.query_capabilities.flatMap(capability => capability.query_packs);
    const expectedModes = catalogQueryModeSchema.array().parse(semanticFixture.node_capability.query_modes);
    expect(packs.map(pack => ({ pack_id: pack.pack_id, query_modes: pack.query_modes }))).toEqual([
      { pack_id: semanticFixture.node_capability.query_pack, query_modes: expectedModes },
    ]);
    const filterFields = manifest.query_capabilities.flatMap(capability => capability.input_fields)
      .flatMap(field => typeof field.name === 'string' && field.name.startsWith('filters.')
        ? [field.name.slice('filters.'.length)] : []);
    expect(filterFields).toEqual(semanticFixture.node_capability.filter_fields);
  });

  for (const example of semanticFixture.cases) {
    test(example.name, async () => {
      // Every semantic fixture is schema-valid, even when this node rejects it.
      const request = catalogQueryRequestSchema.parse(example.body);
      const manifest = catalogManifestSchema.parse(await (await handle(new Request('http://localhost/ocp/manifest'))).json());
      if (example.sdk_error) {
        let validationError: unknown;
        try { validateCatalogQueryRequest(manifest, request); }
        catch (error) { validationError = error; }
        expect(validationError).toBeInstanceOf(OcpClientValidationError);
        if (!(validationError instanceof OcpClientValidationError)) throw new Error('SDK should reject this request');
        expect(validationError.details.code).toBe(example.sdk_error);
      } else {
        const validation = validateCatalogQueryRequest(manifest, request);
        expect(validation.request.query_pack).toBe(semanticFixture.node_capability.query_pack);
        expect(validation.policy_summary.query_mode).toBe('keyword');
        expect(validation.policy_summary.accepted_filters).toEqual([]);
      }
      await assertQueryCase(example);
    });
  }
});

const get = (path: string) => handle(new Request(`http://localhost${path}`));
const post = (path: string, body: unknown) =>
  handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

async function body(res: Response) {
  return res.json();
}

describe('minimal TypeScript OCP Catalog Node', () => {
  test('manifest conforms to catalogManifestSchema', async () => {
    const parsed = catalogManifestSchema.parse(await body(await get('/ocp/manifest')));
    expect(parsed.object_contracts).toEqual([]);
    expect(parsed.query_capabilities.length).toBeGreaterThan(0);
  });

  test('health conforms to catalogHealthResponseSchema', async () => {
    const parsed = catalogHealthResponseSchema.parse(await body(await get('/ocp/health')));
    expect(parsed.ready).toBe(true);
    expect(parsed.status).toBe('healthy');
  });

  test('well-known discovery points at the OCP endpoints', async () => {
    const disco: any = await body(await get('/.well-known/ocp-catalog'));
    expect(disco.kind).toBe('WellKnownCatalogDiscovery');
    expect(disco.query_url).toContain('/ocp/query');
    expect(disco.resolve_url).toContain('/ocp/resolve');
  });

  test('query conforms to catalogQueryResultSchema and filters by keyword', async () => {
    const parsed = catalogQueryResultSchema.parse(await body(await post('/ocp/query', { query: 'headphones' })));
    expect(parsed.result_count).toBe(1);
    expect(parsed.entries[0]!.entry.title).toContain('Headphones');
    expect(parsed.page.offset).toBe(0);
  });

  test('empty query returns all products', async () => {
    const parsed = catalogQueryResultSchema.parse(await body(await post('/ocp/query', {})));
    expect(parsed.result_count).toBe(3);
  });

  test('follows cursors without losing or repeating products and terminates on the last page', async () => {
    const ids: string[] = [];
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < 3; pageNumber++) {
      const result = catalogQueryResultSchema.parse(await body(await post('/ocp/query', { limit: 1, cursor })));
      expect(result.result_count).toBe(1);
      expect(result.page.offset).toBe(0);
      expect(result.page.has_more).toBe(pageNumber < 2);
      ids.push(result.entries[0]!.entry.entry_id);
      cursor = result.page.next_cursor;
    }
    expect(new Set(ids).size).toBe(3);
    expect(cursor).toBeUndefined();
    const end = catalogQueryResultSchema.parse(await body(await post('/ocp/query', { limit: 1, cursor: '999' })));
    expect(end.entries).toEqual([]);
    expect(end.page.has_more).toBe(false);
  });

  test('rejects malformed cursors instead of returning the first page again', async () => {
    for (const cursor of ['-1', '1.5', 'wrong', '9007199254740992', null, 1]) {
      expect((await post('/ocp/query', { limit: 1, cursor })).status).toBe(400);
    }
  });

  test('resolve conforms to resolvableReferenceSchema', async () => {
    const parsed = resolvableReferenceSchema.parse(
      await body(await post('/ocp/resolve', { entry_id: 'entry_example_inmemory_sku-001' })),
    );
    expect(parsed.title).toContain('Headphones');
    expect(parsed.action_bindings[0]!.action_type).toBe('url');
  });

  test('resolve of an unknown entry returns 404', async () => {
    const res = await post('/ocp/resolve', { entry_id: 'entry_example_inmemory_nope' });
    expect(res.status).toBe(404);
  });
});
