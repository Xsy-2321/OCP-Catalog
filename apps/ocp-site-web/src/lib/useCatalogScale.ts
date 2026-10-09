import { useDirectory } from './useDirectory';
import {
  aggregateCatalogScale,
  type CatalogScale,
  type ManifestProbe,
} from './catalogScale';

/**
 * Network-wide product-scale snapshot.
 *
 * The per-catalog `catalog_entry_count` already rides along in each search
 * result's `route_hint.metadata.data_profile` — the registry computes it during
 * its scheduled refresh and serves it from cache. So this hook just reads what
 * the directory search already returned; it does NOT fan out a manifest fetch
 * per catalog on every page load.
 */
export function useCatalogScale(): CatalogScale {
  const { catalogs, isLoading, registries } = useDirectory({ pollMs: 60_000, searchLimit: 50 });

  // Still waiting on the very first directory response — nothing to show yet.
  if (isLoading && catalogs.length === 0) {
    return {
      status: 'loading',
      storedTotal: 0,
      storedCatalogCount: 0,
      streamedCatalogCount: 0,
    };
  }

  if (registries.some((registry) => registry.status === 'unreachable')) {
    return { status: 'unavailable', storedTotal: 0, storedCatalogCount: 0, streamedCatalogCount: 0 };
  }

  // Each discovered catalog becomes a settled probe: it has a data_profile count
  // (stored) or it does not (streamed). No network call — the value is already here.
  const probes: ManifestProbe[] = catalogs.map((catalog) => {
    const count = catalog.route_hint?.metadata?.data_profile?.catalog_entry_count;
    return {
      status: 'ready',
      dataProfileCount: typeof count === 'number' ? count : null,
    };
  });

  return aggregateCatalogScale(probes);
}
