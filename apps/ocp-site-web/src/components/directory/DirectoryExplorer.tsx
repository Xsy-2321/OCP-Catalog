import { useMemo, useState } from 'react';
import { AlertTriangle, Network, RefreshCw } from 'lucide-react';
import { useDirectory, type CatalogWithSources } from '../../lib/useDirectory';
import { useDocsLocale, resolveLocalizedText } from '../../content/i18n';
import { DirectoryTopology } from './DirectoryTopology';
import { RegistryCard } from './RegistryCard';
import { CatalogCard } from './CatalogCard';
import { CatalogDrawer } from './CatalogDrawer';
import { DirectoryFilters, type DirectoryFilterState } from './DirectoryFilters';

function matchesFilters(catalog: CatalogWithSources, state: DirectoryFilterState): boolean {
  if (state.query.trim().length > 0) {
    const q = state.query.toLowerCase();
    const haystack = [
      catalog.catalog_id,
      catalog.catalog_name ?? '',
      catalog.description ?? '',
      ...(catalog.tags ?? []),
      ...(catalog.domains ?? []),
    ]
      .join(' ')
      .toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  if (state.registryIds.size > 0) {
    const hit = catalog._source_registries.some((id) => state.registryIds.has(id));
    if (!hit) return false;
  }
  if (state.verification.size > 0 && !state.verification.has(catalog.verification_status ?? 'unverified')) {
    return false;
  }
  if (state.trust.size > 0 && !state.trust.has(catalog.trust_tier ?? 'none')) {
    return false;
  }
  if (state.health.size > 0 && !state.health.has(catalog.health_status ?? 'unknown')) {
    return false;
  }
  return true;
}

type Props = {
  /** When true, renders the section heading + intro above the topology. */
  showHeader?: boolean;
};

export function DirectoryExplorer({ showHeader = true }: Props) {
  const { locale } = useDocsLocale();
  const snapshot = useDirectory({ pollMs: 30_000, searchLimit: 50 });
  const [filters, setFilters] = useState<DirectoryFilterState>({
    query: '',
    registryIds: new Set(),
    verification: new Set(),
    trust: new Set(),
    health: new Set(),
  });
  const [openCatalogId, setOpenCatalogId] = useState<string | null>(null);

  const filteredCatalogs = useMemo(
    () => snapshot.catalogs.filter((c) => matchesFilters(c, filters)),
    [snapshot.catalogs, filters],
  );

  const registryOptions = useMemo(
    () =>
      snapshot.registries.map((r) => ({
        id: r.seed.id,
        label: r.discovery?.registration_name ?? resolveLocalizedText(r.seed.name, locale),
      })),
    [snapshot.registries, locale],
  );

  const registryName = (id: string): string => {
    const match = snapshot.registries.find((r) => r.seed.id === id);
    if (!match) return id;
    return match.discovery?.registration_name ?? resolveLocalizedText(match.seed.name, locale);
  };

  const openCatalog = openCatalogId
    ? snapshot.catalogs.find((c) => c.catalog_id === openCatalogId) ?? null
    : null;

  const allRegistriesUnreachable =
    snapshot.registries.length > 0 && snapshot.registries.every((r) => r.status === 'unreachable');

  return (
    <>
      <section className="site-section">
        <div className="site-container">
          <div className="mb-6 flex items-end justify-between gap-4">
            <div>
              <div className="section-kicker inline-flex items-center gap-2">
                <Network className="h-3.5 w-3.5 text-[var(--ocp-cyan)]" />
                {locale === 'zh' ? 'OCP 联邦拓扑' : 'OCP federated topology'}
              </div>
              {showHeader && (
                <>
                  <h1 className="mt-4 max-w-3xl text-4xl font-semibold leading-tight sm:text-5xl">
                    {locale === 'zh'
                      ? '注册节点与 Catalog · 实况一览'
                      : 'Registration nodes & catalogs · live view'}
                  </h1>
                  <p className="mt-3 max-w-2xl text-base leading-7 text-[var(--text-muted)]">
                    {locale === 'zh'
                      ? 'OCP 是开放协议，任何主体都能运行注册节点与 Catalog。本页以站点维护的已知注册节点为入口，实时聚合它们索引的 Catalog metadata。'
                      : 'OCP is an open protocol — anyone can run a registration node or catalog. This page seeds known registration nodes and aggregates the catalog metadata they index, live.'}
                  </p>
                </>
              )}
            </div>
            <div className="flex items-center gap-2 text-xs text-[var(--text-faint)]">
              <button type="button" onClick={snapshot.refresh} disabled={snapshot.isLoading} aria-label={locale === 'zh' ? '刷新目录' : 'Refresh directory'}>
                <RefreshCw className={`h-3.5 w-3.5 ${snapshot.isLoading ? 'animate-spin text-[var(--ocp-cyan)]' : ''}`} />
              </button>
              <span className="hidden font-mono tabular-nums sm:inline">
                {snapshot.lastUpdated
                  ? new Date(snapshot.lastUpdated).toLocaleTimeString(undefined, {
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    })
                  : '—'}
              </span>
            </div>
          </div>

          <DirectoryTopology snapshot={snapshot} locale={locale} />
        </div>
      </section>

      <section className="site-section border-y border-[var(--border-soft)] bg-[var(--ocp-porcelain)]">
        <div className="site-container">
          <div className="mb-5 flex items-end justify-between">
            <div>
              <div className="section-kicker">{locale === 'zh' ? '注册节点' : 'Registration nodes'}</div>
              <h2 className="mt-3 text-2xl font-semibold leading-tight">
                {locale === 'zh' ? '我们已知的注册节点' : 'Known registration nodes'}
              </h2>
            </div>
            <span className="hidden font-mono text-xs uppercase tracking-wider text-[var(--text-faint)] sm:inline">
              {snapshot.stats.registriesLive}/{snapshot.stats.registriesTotal}{' '}
              {locale === 'zh' ? '在线' : 'live'}
            </span>
          </div>

          {snapshot.registries.length === 0 ? (
            <EmptyState locale={locale} kind="no-seed" />
          ) : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {snapshot.registries.map((runtime) => (
                <RegistryCard key={runtime.seed.id} runtime={runtime} locale={locale} />
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="site-section">
        <div className="site-container">
          <div className="mb-5">
            <div className="section-kicker">Catalogs</div>
            <h2 className="mt-3 text-2xl font-semibold leading-tight">
              {locale === 'zh' ? '联邦发现的 Catalog' : 'Catalogs across the network'}
            </h2>
          </div>

          <DirectoryFilters
            state={filters}
            setState={setFilters}
            allRegistries={registryOptions}
            totalShown={filteredCatalogs.length}
            totalAvailable={snapshot.catalogs.length}
            locale={locale}
          />

          {snapshot.registries.some((registry) => registry.status === 'unreachable') && !allRegistriesUnreachable && (
            <p role="status" className="mt-4 text-sm text-[var(--ocp-vermilion)]">
              {locale === 'zh' ? '部分注册节点暂不可用，当前列表仅包含成功返回的目录。' : 'Some registries are unavailable. This list includes only successful responses.'}
            </p>
          )}

          {snapshot.isLoading && snapshot.catalogs.length === 0 ? (
            <p role="status" className="mt-6 text-sm text-[var(--text-muted)]">{locale === 'zh' ? '正在查询目录…' : 'Loading catalogs…'}</p>
          ) : allRegistriesUnreachable ? (
            <div className="mt-6">
              <EmptyState locale={locale} kind="all-offline" />
            </div>
          ) : filteredCatalogs.length === 0 ? (
            <div className="mt-6">
              <EmptyState
                locale={locale}
                kind={snapshot.catalogs.length === 0 ? 'no-catalogs' : 'filtered-empty'}
              />
            </div>
          ) : (
            <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {filteredCatalogs.map((catalog) => (
                <CatalogCard
                  key={catalog.catalog_id}
                  catalog={catalog}
                  locale={locale}
                  onOpen={setOpenCatalogId}
                />
              ))}
            </div>
          )}
        </div>
      </section>

      <CatalogDrawer
        catalog={openCatalog}
        registryName={registryName}
        locale={locale}
        onClose={() => setOpenCatalogId(null)}
      />
    </>
  );
}

function EmptyState({
  locale,
  kind,
}: {
  locale: 'en' | 'zh';
  kind: 'no-seed' | 'all-offline' | 'no-catalogs' | 'filtered-empty';
}) {
  const copy = {
    'no-seed': {
      en: 'No registration nodes are configured. Add entries to src/content/directory/registries.ts.',
      zh: '尚未配置注册节点。请在 src/content/directory/registries.ts 添加条目。',
    },
    'all-offline': {
      en: 'Catalog discovery is temporarily unavailable. Retry using Refresh directory above.',
      zh: '目录发现暂不可用。请使用上方“刷新目录”按钮重试。',
    },
    'no-catalogs': {
      en: 'No catalogs have been indexed by the reachable registries yet.',
      zh: '可访问的注册节点尚未索引任何 catalog。',
    },
    'filtered-empty': {
      en: 'No catalogs match the current filters.',
      zh: '当前过滤条件下没有匹配的 catalog。',
    },
  }[kind];

  return (
    <div className="rounded-md border border-dashed border-[var(--border-soft)] bg-[var(--ocp-porcelain)] p-8 text-center">
      <AlertTriangle className="mx-auto mb-3 h-6 w-6 text-[var(--ocp-gold)]" />
      <p className="text-sm text-[var(--text-muted)]">{copy[locale]}</p>
    </div>
  );
}
