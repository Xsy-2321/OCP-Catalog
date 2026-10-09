import { useCallback, useEffect, useMemo, useState } from 'react';
import { knownRegistries, type KnownRegistry } from '../content/directory/registries';
import { requestJson, startPolling } from './request';

export type RegistrationDiscovery = {
  ocp_version?: string;
  kind?: string;
  registration_id?: string;
  registration_name?: string;
  registration_protocol?: string;
  registration_protocol_version?: string;
  manifest_url?: string;
  catalog_registration_url?: string;
  catalog_search_url?: string;
};

export type CatalogDataProfile = {
  catalog_entry_count?: number;
  object_counts?: Array<{ object_type?: string; count?: number }>;
  counted_at?: string;
};

export type CatalogRouteHintPreview = {
  catalog_id?: string;
  manifest_url?: string;
  query_url?: string;
  resolve_url?: string;
  supported_query_packs?: string[];
  cache_ttl_seconds?: number;
  metadata?: {
    data_profile?: CatalogDataProfile;
    [key: string]: unknown;
  };
};

export type CatalogSearchResultItem = {
  catalog_id: string;
  catalog_name?: string;
  description?: string;
  homepage?: string;
  manifest_url?: string;
  well_known_url?: string;
  supported_query_modes?: string[];
  supported_query_packs?: string[];
  supports_resolve?: boolean;
  tags?: string[];
  domains?: string[];
  verification_status?: string;
  trust_tier?: string;
  health_status?: string;
  score?: number;
  matched_query_packs?: string[];
  route_hint?: CatalogRouteHintPreview;
  explain?: string[];
  [key: string]: unknown;
};

export type RegistryStatus = 'loading' | 'live' | 'unreachable';

export type RegistryRuntime = {
  seed: KnownRegistry;
  status: RegistryStatus;
  discovery: RegistrationDiscovery | null;
  catalogCount: number | null;
  verifiedCount: number | null;
  healthyCount: number | null;
  lastChecked: number | null;
  error?: string;
};

export type CatalogWithSources = CatalogSearchResultItem & {
  _source_registries: string[];
};

export type DirectorySnapshot = {
  registries: RegistryRuntime[];
  catalogs: CatalogWithSources[];
  stats: {
    registriesTotal: number;
    registriesLive: number;
    catalogsTotal: number;
    verifiedCount: number;
    healthyCount: number;
    verifiedRatio: number;
    healthyRatio: number;
  };
  lastUpdated: number | null;
  isLoading: boolean;
  refresh: () => void;
};

type Options = {
  pollMs?: number;
  searchLimit?: number;
};

async function fetchDiscovery(endpoint: string, signal: AbortSignal): Promise<RegistrationDiscovery> {
  const url = `${endpoint.replace(/\/+$/, '')}/.well-known/ocp-registration`;
  const payload = await requestJson(url, { signal });
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('Invalid registration discovery payload');
  }
  const discovery = payload as RegistrationDiscovery;
  if (discovery.catalog_search_url !== undefined && typeof discovery.catalog_search_url !== 'string') {
    throw new Error('Invalid catalog search endpoint');
  }
  return discovery;
}

async function fetchCatalogs(searchUrl: string, limit: number, signal: AbortSignal): Promise<CatalogSearchResultItem[]> {
  const payload = await requestJson(searchUrl, {
    signal,
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      ocp_version: '1.0',
      kind: 'CatalogSearchRequest',
      query: '',
      limit,
    }),
  });
  if (typeof payload !== 'object' || payload === null || !('items' in payload) || !Array.isArray(payload.items)) {
    throw new Error('Invalid catalog search payload: expected items array');
  }
  if (!payload.items.every((item) => typeof item === 'object' && item !== null && typeof item.catalog_id === 'string')) {
    throw new Error('Invalid catalog search item');
  }
  return payload.items as CatalogSearchResultItem[];
}

function resolveSearchUrl(endpoint: string, discovery: RegistrationDiscovery): string {
  if (discovery.catalog_search_url) return discovery.catalog_search_url;
  return `${endpoint.replace(/\/+$/, '')}/ocp/catalogs/search`;
}

function summarize(item: CatalogSearchResultItem) {
  const verified = item.verification_status === 'verified';
  const healthy = item.health_status === 'healthy';
  return { verified, healthy };
}

export async function loadRegistry(seed: KnownRegistry, searchLimit: number, signal: AbortSignal): Promise<{
  runtime: RegistryRuntime;
  catalogs: CatalogSearchResultItem[];
}> {
  let discovery: RegistrationDiscovery | null = null;
  try {
    discovery = await fetchDiscovery(seed.endpoint, signal);
    const catalogs = await fetchCatalogs(resolveSearchUrl(seed.endpoint, discovery), searchLimit, signal);
    return {
      runtime: {
        seed, status: 'live', discovery,
        catalogCount: catalogs.length,
        verifiedCount: catalogs.filter((item) => summarize(item).verified).length,
        healthyCount: catalogs.filter((item) => summarize(item).healthy).length,
        lastChecked: Date.now(),
      },
      catalogs,
    };
  } catch (error) {
    return {
      runtime: {
        seed, status: 'unreachable', discovery,
        catalogCount: null, verifiedCount: null, healthyCount: null,
        lastChecked: Date.now(),
        error: `${discovery ? 'Catalog search' : 'Discovery'}: ${error instanceof Error ? error.message : 'unknown'}`,
      },
      catalogs: [],
    };
  }
}

export function useDirectory({ pollMs = 30_000, searchLimit = 50 }: Options = {}): DirectorySnapshot {
  const [registries, setRegistries] = useState<RegistryRuntime[]>(() =>
    knownRegistries.map((seed) => ({
      seed,
      status: 'loading' as RegistryStatus,
      discovery: null,
      catalogCount: null,
      verifiedCount: null,
      healthyCount: null,
      lastChecked: null,
    })),
  );
  const [catalogsByRegistry, setCatalogsByRegistry] = useState<Record<string, CatalogSearchResultItem[]>>({});
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => {
    setIsLoading(true);
    setRevision((value) => value + 1);
  }, []);

  useEffect(() => {
    async function loadAll(signal: AbortSignal) {
      const results = await Promise.all(knownRegistries.map((seed) => loadRegistry(seed, searchLimit, signal)));
      if (signal.aborted) return;
      setRegistries(results.map((r) => r.runtime));
      const byRegistry: Record<string, CatalogSearchResultItem[]> = {};
      for (let i = 0; i < knownRegistries.length; i += 1) {
        byRegistry[knownRegistries[i].id] = results[i].catalogs;
      }
      setCatalogsByRegistry(byRegistry);
      setLastUpdated(Date.now());
      setIsLoading(false);
    }

    const polling = startPolling(loadAll, pollMs);
    return () => polling.stop();
  }, [pollMs, searchLimit, revision]);
  const catalogs = useMemo<CatalogWithSources[]>(() => {
    const map = new Map<string, CatalogWithSources>();
    for (const [registryId, items] of Object.entries(catalogsByRegistry)) {
      for (const item of items) {
        const existing = map.get(item.catalog_id);
        if (existing) {
          if (!existing._source_registries.includes(registryId)) {
            existing._source_registries.push(registryId);
          }
        } else {
          map.set(item.catalog_id, { ...item, _source_registries: [registryId] });
        }
      }
    }
    return [...map.values()].sort((a, b) => {
      const sa = a.score ?? 0;
      const sb = b.score ?? 0;
      return sb - sa;
    });
  }, [catalogsByRegistry]);

  const stats = useMemo(() => {
    const registriesTotal = registries.length;
    const registriesLive = registries.filter((r) => r.status === 'live').length;
    const catalogsTotal = catalogs.length;
    let verifiedCount = 0;
    let healthyCount = 0;
    for (const item of catalogs) {
      if (item.verification_status === 'verified') verifiedCount += 1;
      if (item.health_status === 'healthy') healthyCount += 1;
    }
    return {
      registriesTotal,
      registriesLive,
      catalogsTotal,
      verifiedCount,
      healthyCount,
      verifiedRatio: catalogsTotal > 0 ? verifiedCount / catalogsTotal : 0,
      healthyRatio: catalogsTotal > 0 ? healthyCount / catalogsTotal : 0,
    };
  }, [registries, catalogs]);

  return { registries, catalogs, stats, lastUpdated, isLoading, refresh };
}
