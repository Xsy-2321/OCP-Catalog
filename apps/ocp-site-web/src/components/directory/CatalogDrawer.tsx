import { useEffect } from 'react';
import { AlertCircle, ExternalLink, Loader2, Terminal, X } from 'lucide-react';
import type { CatalogWithSources } from '../../lib/useDirectory';
import {
  buildSampleQueryBody,
  useCatalogManifest,
  type CatalogManifest,
} from '../../lib/useCatalogManifest';
import type { DocsLocale } from '../../content/i18n';

type Props = {
  catalog: CatalogWithSources | null;
  registryName: (id: string) => string;
  locale: DocsLocale;
  onClose: () => void;
};

export function CatalogDrawer({ catalog, registryName, locale, onClose }: Props) {
  useEffect(() => {
    if (!catalog) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [catalog, onClose]);

  const manifestUrl = catalog?.manifest_url ?? catalog?.route_hint?.manifest_url ?? null;
  const manifestState = useCatalogManifest(manifestUrl);
  const open = !!catalog;

  return (
    <>
      <div
        className={`catalog-drawer-scrim ${open ? 'is-open' : ''}`}
        onClick={onClose}
        aria-hidden={!open}
      />
      <aside className={`catalog-drawer ${open ? 'is-open' : ''}`} aria-hidden={!open}>
        {catalog && (
          <>
            <header className="flex items-start justify-between gap-3 border-b border-[var(--border-soft)] px-6 py-5">
              <div className="min-w-0">
                <div className="font-mono text-[11px] uppercase tracking-[0.1em] text-[var(--text-faint)]">
                  {catalog.catalog_id}
                </div>
                <h2 className="mt-1 truncate text-xl font-semibold text-[var(--ocp-ink)]">
                  {catalog.catalog_name ?? catalog.catalog_id}
                </h2>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="grid h-9 w-9 place-items-center rounded-md border border-[var(--border-soft)] bg-[var(--surface-1)] hover:bg-[var(--surface-glass)]"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </header>

            <div className="space-y-5 px-6 py-5">
              {catalog.description && (
                <p className="text-sm leading-6 text-[var(--text-strong)]">{catalog.description}</p>
              )}

              <Section title={locale === 'zh' ? '识别与端点' : 'Identity & endpoints'}>
                <KV k="homepage" v={catalog.homepage} link />
                <KV k="manifest_url" v={catalog.manifest_url} link mono />
                <KV k="well_known_url" v={catalog.well_known_url} link mono />
                {catalog.domains && catalog.domains.length > 0 && (
                  <KV k="domains" v={catalog.domains.join(', ')} mono />
                )}
              </Section>

              <Section title={locale === 'zh' ? '能力' : 'Capabilities'}>
                <KV
                  k="supports_resolve"
                  v={catalog.supports_resolve === undefined ? undefined : String(catalog.supports_resolve)}
                  mono
                />
                <KVChips k="query_modes" values={catalog.supported_query_modes} />
                <KVChips k="query_packs" values={catalog.supported_query_packs} />
              </Section>

              <Section title={locale === 'zh' ? '信任与健康' : 'Trust & health'}>
                <KV k="verification_status" v={catalog.verification_status} mono />
                <KV k="trust_tier" v={catalog.trust_tier} mono />
                <KV k="health_status" v={catalog.health_status} mono />
              </Section>

              {catalog.route_hint && (
                <Section title={locale === 'zh' ? 'Route Hint' : 'Route hint'}>
                  <KV k="manifest_url" v={catalog.route_hint.manifest_url} link mono />
                  <KV k="query_url" v={catalog.route_hint.query_url} link mono />
                  <KV k="resolve_url" v={catalog.route_hint.resolve_url} link mono />
                  {typeof catalog.route_hint.cache_ttl_seconds === 'number' && (
                    <KV k="cache_ttl" v={`${catalog.route_hint.cache_ttl_seconds}s`} mono />
                  )}
                  <KVChips
                    k="supported_query_packs"
                    values={catalog.route_hint.supported_query_packs}
                  />
                </Section>
              )}

              <LiveManifestSection
                manifestUrl={manifestUrl}
                status={manifestState.status}
                error={manifestState.error}
                manifest={manifestState.manifest}
                onRefresh={manifestState.refresh}
                locale={locale}
              />

              {catalog.tags && catalog.tags.length > 0 && (
                <Section title={locale === 'zh' ? '标签' : 'Tags'}>
                  <div className="flex flex-wrap gap-1.5">
                    {catalog.tags.map((tag) => (
                      <span
                        key={tag}
                        className="rounded border border-[var(--border-soft)] bg-[var(--surface-1)] px-2 py-0.5 text-[11px] text-[var(--text-muted)]"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                </Section>
              )}

              {catalog.explain && catalog.explain.length > 0 && (
                <Section title={locale === 'zh' ? '匹配解释' : 'Match explain'}>
                  <ul className="space-y-1.5 text-sm text-[var(--text-strong)]">
                    {catalog.explain.map((line, i) => (
                      <li key={i} className="flex gap-2">
                        <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--ocp-cyan)]" />
                        {line}
                      </li>
                    ))}
                  </ul>
                </Section>
              )}

              <Section title={locale === 'zh' ? '索引来源' : 'Indexed by'}>
                <div className="flex flex-wrap gap-1.5">
                  {catalog._source_registries.map((id) => (
                    <span
                      key={id}
                      className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border-soft)] bg-[var(--surface-1)] px-2 py-1 text-[11px]"
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-[var(--ocp-cyan)]" />
                      <span className="font-mono text-[var(--text-strong)]">{registryName(id)}</span>
                    </span>
                  ))}
                </div>
              </Section>
            </div>
          </>
        )}
      </aside>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--text-faint)]">{title}</h3>
      <div className="space-y-1.5">{children}</div>
    </section>
  );
}

function KV({
  k,
  v,
  link,
  mono,
}: {
  k: string;
  v?: string;
  link?: boolean;
  mono?: boolean;
}) {
  if (!v) return null;
  const valueClass = `min-w-0 flex-1 break-all text-sm text-[var(--text-strong)] ${mono ? 'font-mono text-[12px]' : ''}`;
  return (
    <div className="flex items-baseline gap-3">
      <span className="w-32 shrink-0 font-mono text-[10px] uppercase tracking-wider text-[var(--text-faint)]">{k}</span>
      {link ? (
        <a
          href={v}
          target="_blank"
          rel="noreferrer"
          className={`${valueClass} inline-flex items-center gap-1 text-[var(--ocp-cyan)] hover:underline`}
        >
          {v}
          <ExternalLink className="h-3 w-3 shrink-0" />
        </a>
      ) : (
        <span className={valueClass}>{v}</span>
      )}
    </div>
  );
}

function KVChips({ k, values }: { k: string; values?: string[] }) {
  if (!values || values.length === 0) return null;
  return (
    <div className="flex items-baseline gap-3">
      <span className="w-32 shrink-0 font-mono text-[10px] uppercase tracking-wider text-[var(--text-faint)]">{k}</span>
      <div className="flex min-w-0 flex-1 flex-wrap gap-1">
        {values.map((value) => (
          <code key={value} className="rounded bg-[var(--surface-1)] px-1.5 py-0.5 text-[11px] text-[var(--text-strong)]">
            {value}
          </code>
        ))}
      </div>
    </div>
  );
}

function LiveManifestSection({
  manifestUrl,
  status,
  error,
  manifest,
  onRefresh,
  locale,
}: {
  manifestUrl: string | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  manifest: CatalogManifest | null;
  onRefresh: () => void;
  locale: DocsLocale;
}) {
  if (!manifestUrl) return null;

  const title = locale === 'zh' ? '实时 Manifest' : 'Live manifest';
  const hint =
    locale === 'zh'
      ? '我们已为你点过 Catalog 的 manifest，下面是它当前声明的真实能力。这才是构造 query 的权威依据。'
      : "We probed the catalog's manifest. Below is what it currently declares — the authoritative source for shaping a real query.";

  if (status === 'loading') {
    return (
      <Section title={title}>
        <p className="text-xs text-[var(--text-faint)]">{hint}</p>
        <div className="mt-2 inline-flex items-center gap-2 rounded-md border border-[var(--border-soft)] bg-[var(--surface-1)] px-3 py-2 text-xs text-[var(--text-muted)]">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--ocp-cyan)]" />
          {locale === 'zh' ? '拉取中…' : 'Fetching manifest…'}
        </div>
      </Section>
    );
  }

  if (status === 'error') {
    return (
      <Section title={title}>
        <p className="text-xs text-[var(--text-faint)]">{hint}</p>
        <div className="mt-2 flex items-start gap-2 rounded-md border border-[var(--ocp-vermilion)]/30 bg-[var(--ocp-vermilion)]/8 p-3 text-xs text-[var(--text-strong)]">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--ocp-vermilion)]" />
          <div className="min-w-0">
            <div className="font-semibold text-[var(--ocp-vermilion)]">
              {locale === 'zh' ? '拉取失败' : 'Could not fetch manifest'}
            </div>
            <div className="mt-1 break-all font-mono text-[11px] text-[var(--text-muted)]">{error ?? 'unknown error'}</div>
            <div className="mt-1 text-[var(--text-muted)]">
              {locale === 'zh'
                ? '可能原因：目标 Catalog 未启用 CORS、暂时离线、或 URL 错误。可手动打开下方链接验证。'
                : 'Likely the target catalog has no CORS, is temporarily offline, or the URL is wrong. Open the link below to verify manually.'}
            </div>
            <a
              href={manifestUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-flex items-center gap-1 break-all font-mono text-[11px] text-[var(--ocp-cyan)] hover:underline"
            >
              {manifestUrl}
              <ExternalLink className="h-3 w-3 shrink-0" />
            </a>
            <button type="button" onClick={onRefresh} className="mt-2 block rounded border border-[var(--border-soft)] px-3 py-1.5">
              {locale === 'zh' ? '重试' : 'Retry'}
            </button>
          </div>
        </div>
      </Section>
    );
  }

  if (status !== 'ready' || !manifest) return null;

  const sample = buildSampleQueryBody(manifest);
  const queryEndpoint = manifest.endpoints?.query?.url;
  const allEndpoints = Object.entries(manifest.endpoints ?? {});

  return (
    <Section title={title}>
      <p className="mb-3 text-xs text-[var(--text-faint)]">{hint}</p>
      <button type="button" onClick={onRefresh} className="mb-3 rounded border border-[var(--border-soft)] px-3 py-1.5 text-xs">
        {locale === 'zh' ? '刷新 Manifest' : 'Refresh manifest'}
      </button>

      {allEndpoints.length > 0 && (
        <div className="mb-3 space-y-1">
          {allEndpoints.map(([name, ep]) => (
            <div key={name} className="flex items-baseline gap-2 text-[11px]">
              <span className="w-20 shrink-0 font-mono uppercase tracking-wider text-[var(--text-faint)]">{name}</span>
              <span
                className="shrink-0 rounded bg-[var(--ocp-ink)] px-1.5 py-0.5 font-mono text-[10px] font-bold text-[var(--ocp-paper)]"
              >
                {ep.method ?? 'GET'}
              </span>
              {ep.url ? (
                <a
                  href={ep.url}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--ocp-cyan)] hover:underline"
                >
                  {ep.url}
                </a>
              ) : (
                <span className="text-[var(--text-faint)]">—</span>
              )}
            </div>
          ))}
        </div>
      )}

      {manifest.query_capabilities && manifest.query_capabilities.length > 0 && (
        <div className="mb-3 space-y-2">
          <div className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-faint)]">
            {locale === 'zh' ? '查询能力' : 'Query capabilities'}
          </div>
          {manifest.query_capabilities.map((cap, i) => (
            <div
              key={cap.capability_id ?? i}
              className="rounded-md border border-[var(--border-soft)] bg-[var(--surface-1)] p-2.5"
            >
              <div className="flex flex-wrap items-baseline gap-2">
                <code className="font-mono text-[11px] font-semibold text-[var(--ocp-ink)]">
                  {cap.capability_id ?? '—'}
                </code>
                {cap.supports_explain && (
                  <span className="rounded bg-[var(--ocp-cyan)]/14 px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider text-[var(--ocp-cyan)]">
                    explain
                  </span>
                )}
                {cap.supports_resolve && (
                  <span className="rounded bg-[var(--ocp-green)]/14 px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider text-[var(--ocp-green)]">
                    resolve
                  </span>
                )}
              </div>
              {cap.name && <div className="mt-1 text-xs text-[var(--text-strong)]">{cap.name}</div>}
              {cap.description && (
                <div className="mt-0.5 text-[11px] leading-5 text-[var(--text-muted)]">{cap.description}</div>
              )}
              {cap.query_packs && cap.query_packs.length > 0 && (
                <div className="mt-2 space-y-1">
                  {cap.query_packs.map((pack, j) => (
                    <div key={pack.pack_id ?? j} className="flex flex-wrap items-baseline gap-1.5">
                      <code className="rounded bg-[var(--surface-1)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-strong)]">
                        {pack.pack_id}
                      </code>
                      {pack.query_modes?.map((mode) => (
                        <code
                          key={mode}
                          className="rounded border border-[var(--border-soft)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-muted)]"
                        >
                          {mode}
                        </code>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {sample && queryEndpoint && (
        <div className="mt-3">
          <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-[var(--text-faint)]">
            <Terminal className="h-3 w-3" />
            {locale === 'zh' ? '示例请求' : 'Sample query body'}
          </div>
          <div className="mb-1.5 font-mono text-[11px] text-[var(--text-muted)]">
            POST {queryEndpoint}
          </div>
          <pre className="overflow-x-auto rounded-md border border-[var(--border-soft)] bg-[var(--ocp-code)] p-3 font-mono text-[11px] leading-5 text-[#cfe6c4]">
            {JSON.stringify(sample, null, 2)}
          </pre>
          <p className="mt-2 text-[11px] text-[var(--text-faint)]">
            {locale === 'zh'
              ? '基于 manifest 第一项 capability/pack 生成，已按 OCP 查询协议校验。'
              : "Generated from the manifest's first capability/pack and validated against the OCP query schema."}
          </p>
        </div>
      )}
    </Section>
  );
}
