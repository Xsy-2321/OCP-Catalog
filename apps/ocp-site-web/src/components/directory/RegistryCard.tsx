import { ExternalLink, ShieldCheck, Signal, SignalZero } from 'lucide-react';
import type { RegistryRuntime } from '../../lib/useDirectory';
import { resolveLocalizedText, type DocsLocale } from '../../content/i18n';

type Props = {
  runtime: RegistryRuntime;
  locale: DocsLocale;
};

function statusBadgeCopy(status: RegistryRuntime['status'], locale: DocsLocale) {
  if (status === 'live') return locale === 'zh' ? '在线' : 'live';
  if (status === 'unreachable') return locale === 'zh' ? '暂不可用' : 'unavailable';
  return locale === 'zh' ? '检测中' : 'probing';
}

export function RegistryCard({ runtime, locale }: Props) {
  const { seed, discovery, status, catalogCount, verifiedCount, healthyCount } = runtime;
  const live = status === 'live';
  const StatusIcon = live ? Signal : status === 'unreachable' ? SignalZero : Signal;
  const statusColor = live
    ? 'var(--ocp-green)'
    : status === 'unreachable'
      ? 'var(--ocp-vermilion)'
      : 'var(--ocp-gold)';

  return (
    <article className={`registry-card ${live ? '' : 'is-offline'}`}>
      <header className="flex items-center justify-between gap-3 border-b border-[var(--border-soft)] pb-3">
        <div className="min-w-0">
          <div className="font-mono text-[11px] uppercase tracking-[0.1em] text-[var(--text-faint)]">{seed.id}</div>
          <h3 className="mt-1 truncate text-lg font-semibold text-[var(--ocp-ink)]">
            {discovery?.registration_name ?? resolveLocalizedText(seed.name, locale)}
          </h3>
        </div>
        <span
          className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-soft)] bg-[var(--surface-1)] px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider"
          style={{ color: statusColor }}
        >
          <StatusIcon className="h-3 w-3" />
          {statusBadgeCopy(status, locale)}
          {live && (
            <span
              className="ml-0.5 h-1.5 w-1.5 rounded-full"
              style={{ background: statusColor, boxShadow: `0 0 0 3px ${statusColor}22` }}
            />
          )}
        </span>
      </header>

      <p className="mt-3 line-clamp-2 text-sm leading-6 text-[var(--text-muted)]">{resolveLocalizedText(seed.intro, locale)}</p>

      <div className="mt-3 flex items-center gap-2 text-xs">
        <a
          href={seed.endpoint}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 truncate font-mono text-[var(--ocp-cyan)] hover:underline"
        >
          {seed.endpoint}
          <ExternalLink className="h-3 w-3 shrink-0" />
        </a>
      </div>

      {discovery?.registration_protocol && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          <span className="rounded border border-[var(--border-soft)] bg-[var(--surface-1)] px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
            {discovery.registration_protocol}
            {discovery.registration_protocol_version ? ` · v${discovery.registration_protocol_version}` : ''}
          </span>
        </div>
      )}

      <dl className="mt-4 grid grid-cols-3 gap-2 border-t border-[var(--border-soft)] pt-3">
        <Metric value={catalogCount ?? '—'} label={locale === 'zh' ? 'catalogs' : 'catalogs'} />
        <Metric
          value={verifiedCount ?? '—'}
          label={locale === 'zh' ? '已验证' : 'verified'}
          icon={ShieldCheck}
          tone="cyan"
        />
        <Metric value={healthyCount ?? '—'} label={locale === 'zh' ? '健康' : 'healthy'} tone="green" />
      </dl>

      {runtime.error && (
        <p role="status" className="mt-3 break-all text-xs text-[var(--ocp-vermilion)]">
          {runtime.error}
        </p>
      )}

      <footer className="mt-3 flex items-center justify-between border-t border-[var(--border-soft)] pt-3 text-[11px] text-[var(--text-faint)]">
        <span>{resolveLocalizedText(seed.operator, locale)}</span>
        <span className="font-mono uppercase tracking-wider">{seed.region}</span>
      </footer>
    </article>
  );
}

function Metric({
  value,
  label,
  icon: Icon,
  tone,
}: {
  value: number | string;
  label: string;
  icon?: typeof ShieldCheck;
  tone?: 'cyan' | 'green';
}) {
  const color =
    tone === 'cyan' ? 'var(--ocp-cyan)' : tone === 'green' ? 'var(--ocp-green)' : 'var(--ocp-ink)';
  return (
    <div>
      <dt className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-faint)]">
        {Icon ? <Icon className="h-3 w-3" /> : null}
        {label}
      </dt>
      <dd className="font-mono text-lg font-semibold tabular-nums" style={{ color }}>
        {value}
      </dd>
    </div>
  );
}
