import { describe, expect, test } from 'bun:test';
import { catalogManifestSchema, catalogQueryRequestSchema } from '@ocp-catalog/ocp-schema';
import { buildSampleQueryBody, createManifestLoader } from './useCatalogManifest';

const manifest = catalogManifestSchema.parse({
  ocp_version: '1.0', kind: 'CatalogManifest', id: 'catalog:test',
  catalog_id: 'test', catalog_name: 'Test catalog',
  endpoints: {
    query: { url: 'https://catalog.example/ocp/query', method: 'POST' },
    resolve: { url: 'https://catalog.example/ocp/resolve', method: 'POST' },
  },
  query_capabilities: [{
    capability_id: 'products',
    query_packs: [{ pack_id: 'product.search', query_modes: ['hybrid'] }],
  }],
  object_contracts: [],
});

function fakeFetch(handler: (url: string, options?: RequestInit) => Promise<Response>): typeof fetch {
  return handler as typeof fetch;
}

describe('manifest recovery and protocol samples', () => {
  test('generated JSON round-trips through the shared query request schema', () => {
    const sample = buildSampleQueryBody(manifest);
    expect(catalogQueryRequestSchema.safeParse(JSON.parse(JSON.stringify(sample))).success).toBe(true);
    expect(sample?.query).toBe('wireless headphones');
    expect(sample?.query_mode).toBe('hybrid');
    expect(sample?.query_pack).toBe('product.search');
    expect(sample?.catalog_id).toBe('test');
    expect(buildSampleQueryBody(null)).toBeNull();
    expect(buildSampleQueryBody({ ...manifest, query_capabilities: [] })).toBeNull();
  });

  test('a temporary 503 can recover on the next opening without a page reload', async () => {
    let calls = 0;
    const load = createManifestLoader({ fetchImpl: fakeFetch(async () => {
      calls += 1;
      return calls === 1 ? new Response('unavailable', { status: 503 }) : Response.json(manifest);
    }) });
    expect((await load('https://catalog.example/manifest')).status).toBe('error');
    expect((await load('https://catalog.example/manifest')).status).toBe('ready');
    expect(calls).toBe(2);
  });

  test('invalid protocol data is not cached as a usable manifest', async () => {
    let calls = 0;
    const load = createManifestLoader({ fetchImpl: fakeFetch(async () => {
      calls += 1;
      return Response.json(calls === 1 ? { catalog_id: 'test' } : manifest);
    }) });
    expect((await load('https://catalog.example/manifest')).status).toBe('error');
    expect((await load('https://catalog.example/manifest')).status).toBe('ready');
    expect(calls).toBe(2);
  });

  test('success expires and explicit refresh bypasses the success cache', async () => {
    let now = 1000;
    let calls = 0;
    const load = createManifestLoader({ now: () => now, ttlMs: 100, fetchImpl: fakeFetch(async () => {
      calls += 1;
      return Response.json({ ...manifest, catalog_name: `Version ${calls}` });
    }) });
    const url = 'https://catalog.example/manifest';
    expect((await load(url)).status).toBe('ready');
    await load(url);
    expect(calls).toBe(1);
    now += 100;
    await load(url);
    expect(calls).toBe(2);
    const refreshed = await load(url, { force: true });
    expect(refreshed.status === 'ready' && refreshed.manifest.catalog_name).toBe('Version 3');
    const reopened = await load(url);
    expect(reopened.status === 'ready' && reopened.manifest.catalog_name).toBe('Version 3');
    expect(calls).toBe(3);
  });

  test('cancelling one consumer preserves another consumer, then reopening recovers', async () => {
    let complete: (response: Response) => void = () => {};
    let calls = 0;
    let requestSignal: AbortSignal | null = null;
    const load = createManifestLoader({ fetchImpl: fakeFetch(async (_, options) => {
      calls += 1;
      requestSignal = options?.signal ?? null;
      if (calls > 1) return Response.json(manifest);
      return new Promise((resolve) => { complete = resolve; });
    }) });
    const url = 'https://catalog.example/manifest';
    const first = new AbortController();
    const second = new AbortController();
    const one = load(url, { signal: first.signal });
    const two = load(url, { signal: second.signal });
    first.abort();
    expect((await one).status).toBe('error');
    expect(requestSignal!.aborted).toBe(false);
    second.abort();
    expect((await two).status).toBe('error');
    expect(requestSignal!.aborted).toBe(true);
    expect((await load(url)).status).toBe('ready');
    complete(Response.json(manifest));
    expect(calls).toBe(2);
  });

  test('a stalled manifest is bounded by timeout and the next attempt succeeds', async () => {
    let calls = 0;
    const load = createManifestLoader({ timeoutMs: 5, fetchImpl: fakeFetch(async () => {
      calls += 1;
      return calls === 1 ? new Promise<Response>(() => {}) : Response.json(manifest);
    }) });
    const failed = await load('https://catalog.example/manifest');
    expect(failed.status === 'error' && failed.error).toContain('timed out');
    expect((await load('https://catalog.example/manifest')).status).toBe('ready');
  });
});
