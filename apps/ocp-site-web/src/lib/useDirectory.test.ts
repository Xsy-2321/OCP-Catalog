import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { knownRegistries } from '../content/directory/registries';
import { loadRegistry } from './useDirectory';

afterEach(() => { fetchSpy?.mockRestore(); });
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>> | undefined;

describe('registry discovery distinguishes an outage from an empty catalog', () => {
  test('discovery success plus search 503 is unavailable and can recover', async () => {
    let searches = 0;
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (url) => {
      if (String(url).includes('.well-known')) return Response.json({ catalog_search_url: 'https://registry.test/search' });
      searches += 1;
      return searches === 1 ? new Response('unavailable', { status: 503 }) : Response.json({ items: [{ catalog_id: 'healthy-catalog' }] });
    }) as typeof fetch);
    const first = await loadRegistry(knownRegistries[0], 50, new AbortController().signal);
    expect(first.runtime.status).toBe('unreachable');
    expect(first.runtime.discovery).not.toBeNull();
    expect(first.runtime.catalogCount).toBeNull();
    expect(first.runtime.error).toContain('Catalog search: HTTP 503');
    const second = await loadRegistry(knownRegistries[0], 50, new AbortController().signal);
    expect(second.runtime.status).toBe('live');
    expect(second.runtime.catalogCount).toBe(1);
    expect(second.catalogs[0].catalog_id).toBe('healthy-catalog');
  });

  test('only a successful items array represents a real empty catalog', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (url) => {
      return Response.json(String(url).includes('.well-known') ? {} : { items: [] });
    }) as typeof fetch);
    const result = await loadRegistry(knownRegistries[0], 50, new AbortController().signal);
    expect(result.runtime.status).toBe('live');
    expect(result.runtime.catalogCount).toBe(0);
    expect(result.runtime.error).toBeUndefined();
  });

  test('a malformed search response surfaces an error instead of an empty list', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (url) => {
      return Response.json(String(url).includes('.well-known') ? {} : { message: 'proxy error' });
    }) as typeof fetch);
    const result = await loadRegistry(knownRegistries[0], 50, new AbortController().signal);
    expect(result.runtime.status).toBe('unreachable');
    expect(result.runtime.catalogCount).toBeNull();
    expect(result.runtime.error).toContain('expected items array');
  });
});
