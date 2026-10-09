import { useCallback, useEffect, useRef, useState } from 'react';
import {
  catalogManifestSchema,
  catalogQueryRequestSchema,
  type CatalogManifest,
  type CatalogQueryRequest,
} from '@ocp-catalog/ocp-schema';
import { requestJson, REQUEST_TIMEOUT_MS } from './request';

export type { CatalogManifest } from '@ocp-catalog/ocp-schema';
export type CatalogManifestStatus = 'idle' | 'loading' | 'ready' | 'error';
export type ManifestFetchEntry =
  | { status: 'ready'; manifest: CatalogManifest }
  | { status: 'error'; error: string };

export const MANIFEST_CACHE_TTL_MS = 60_000;

type FetchOptions = { force?: boolean; signal?: AbortSignal };
type LoaderOptions = { ttlMs?: number; timeoutMs?: number; now?: () => number; fetchImpl?: typeof fetch };

export function createManifestLoader({
  ttlMs = MANIFEST_CACHE_TTL_MS,
  timeoutMs = REQUEST_TIMEOUT_MS,
  now = Date.now,
  fetchImpl,
}: LoaderOptions = {}) {
  const cache = new Map<string, { entry: ManifestFetchEntry; expiresAt: number }>();
  type Pending = { controller: AbortController; promise: Promise<ManifestFetchEntry>; consumers: number };
  const inflight = new Map<string, Pending>();

  return function fetchManifest(url: string, { force = false, signal }: FetchOptions = {}): Promise<ManifestFetchEntry> {
    const cancelled = (): ManifestFetchEntry => ({ status: 'error', error: 'Request cancelled' });
    if (signal?.aborted) return Promise.resolve(cancelled());
    const cached = cache.get(url);
    if (!force && cached && cached.expiresAt > now()) return Promise.resolve(cached.entry);
    cache.delete(url);

    let pending = inflight.get(url);
    if (!pending) {
      const controller = new AbortController();
      const promise = requestJson(url, { signal: controller.signal, timeoutMs, fetchImpl })
        .then((json): ManifestFetchEntry => {
          if (controller.signal.aborted) throw controller.signal.reason;
          const manifest = catalogManifestSchema.parse(json);
          const entry: ManifestFetchEntry = { status: 'ready', manifest };
          cache.set(url, { entry, expiresAt: now() + ttlMs });
          return entry;
        })
        .catch((error): ManifestFetchEntry => ({
          status: 'error', error: error instanceof Error ? error.message : 'Fetch failed',
        }))
        .finally(() => {
          if (inflight.get(url)?.controller === controller) inflight.delete(url);
        });
      pending = { controller, promise, consumers: 0 };
      inflight.set(url, pending);
    }
    const request = pending;
    request.consumers += 1;
    return new Promise((resolve) => {
      let finished = false;
      const finish = (entry: ManifestFetchEntry) => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener('abort', onAbort);
        request.consumers -= 1;
        resolve(entry);
      };
      const onAbort = () => {
        finish(cancelled());
        if (request.consumers === 0) {
          // Remove immediately so reopening can start a fresh request.
          if (inflight.get(url) === request) inflight.delete(url);
          request.controller.abort(new Error('Request cancelled'));
        }
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      void request.promise.then(finish);
    });
  };
}

export const fetchManifestOnce = createManifestLoader();

export type UseCatalogManifestResult = {
  status: CatalogManifestStatus;
  manifest: CatalogManifest | null;
  error: string | null;
  refresh: () => void;
};

export function useCatalogManifest(manifestUrl: string | null | undefined): UseCatalogManifestResult {
  const [revision, setRevision] = useState(0);
  const consumedRevision = useRef(0);
  const [loaded, setLoaded] = useState<{ url: string; revision: number; entry: ManifestFetchEntry } | null>(null);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    if (!manifestUrl) return;
    const controller = new AbortController();
    const force = revision !== consumedRevision.current;
    consumedRevision.current = revision;
    void fetchManifestOnce(manifestUrl, { force, signal: controller.signal }).then((entry) => {
      if (!controller.signal.aborted) setLoaded({ url: manifestUrl, revision, entry });
    });
    return () => controller.abort();
  }, [manifestUrl, revision]);

  if (!manifestUrl) return { status: 'idle', manifest: null, error: null, refresh };
  if (!loaded || loaded.url !== manifestUrl || loaded.revision !== revision) {
    return { status: 'loading', manifest: null, error: null, refresh };
  }
  if (loaded.entry.status === 'error') return { ...loaded.entry, manifest: null, refresh };
  return { ...loaded.entry, error: null, refresh };
}

/** Generate the same request shape that protocol implementations validate. */
export function buildSampleQueryBody(manifest: CatalogManifest | null): CatalogQueryRequest | null {
  const cap = manifest?.query_capabilities[0];
  const pack = cap?.query_packs[0];
  if (!manifest || !pack) return null;
  return catalogQueryRequestSchema.parse({
    ocp_version: '1.0',
    kind: 'CatalogQueryRequest',
    catalog_id: manifest.catalog_id,
    query_mode: pack.query_modes[0] ?? 'keyword',
    query_pack: pack.pack_id,
    query: 'wireless headphones',
    limit: 10,
  });
}
