export type ManifestProbeStatus = 'pending' | 'ready' | 'error';

/** One catalog's manifest probe, reduced to just what scale needs. */
export type ManifestProbe = {
  status: ManifestProbeStatus;
  /** catalog_entry_count if the manifest has a data_profile, else null. */
  dataProfileCount: number | null;
};

export type CatalogScaleStatus = 'loading' | 'ready' | 'unavailable';

export type CatalogScale = {
  status: CatalogScaleStatus;
  storedTotal: number;
  storedCatalogCount: number;
  streamedCatalogCount: number;
};

/**
 * Reduce a set of per-catalog manifest probes into the two scale dimensions.
 * - stored: manifests that expose data_profile.catalog_entry_count (summed)
 * - streamed: ready manifests with no data_profile (bridge / live forwarding)
 * Errored and pending probes never contribute to totals.
 */
export function aggregateCatalogScale(probes: ManifestProbe[]): CatalogScale {
  let storedTotal = 0;
  let storedCatalogCount = 0;
  let streamedCatalogCount = 0;
  let pendingCount = 0;

  for (const probe of probes) {
    if (probe.status === 'pending') {
      pendingCount += 1;
      continue;
    }
    if (probe.status === 'error') {
      continue;
    }
    // status === 'ready'
    if (probe.dataProfileCount != null) {
      storedTotal += probe.dataProfileCount;
      storedCatalogCount += 1;
    } else {
      streamedCatalogCount += 1;
    }
  }

  let status: CatalogScaleStatus;
  if (pendingCount > 0) {
    status = 'loading';
  } else if (storedCatalogCount > 0) {
    // At least one catalog reported a real catalog_entry_count (a genuine 0 counts).
    status = 'ready';
  } else {
    // Nothing settled, or everything settled but no catalog reported a count —
    // surface as unavailable so the UI shows a placeholder, never a misleading 0.
    status = 'unavailable';
  }

  return { status, storedTotal, storedCatalogCount, streamedCatalogCount };
}
