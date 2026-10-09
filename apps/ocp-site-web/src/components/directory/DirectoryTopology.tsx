import { useMemo, type CSSProperties } from 'react';
import type { DirectorySnapshot } from '../../lib/useDirectory';

type Props = {
  snapshot: DirectorySnapshot;
  locale: 'en' | 'zh';
};

const VIEW_W = 1000;
const VIEW_H = 320;
const REGISTRY_X = 130;
const CATALOG_X_MIN = 540;
const CATALOG_X_MAX = 880;

const trustColor: Record<string, string> = {
  authority: 'var(--ocp-cyan)',
  verified_domain: 'var(--ocp-green)',
  declared: 'var(--ocp-gold)',
  claimed: 'var(--ocp-gold)',
  none: 'rgba(255, 255, 255, 0.42)',
};

export function DirectoryTopology({ snapshot, locale }: Props) {
  const { registries, catalogs, stats } = snapshot;

  const registryPositions = useMemo(() => {
    const n = Math.max(registries.length, 1);
    const step = (VIEW_H - 80) / (n + 1);
    return registries.map((reg, i) => ({
      id: reg.seed.id,
      x: REGISTRY_X,
      y: 40 + step * (i + 1),
      live: reg.status === 'live',
    }));
  }, [registries]);

  const catalogPositions = useMemo(() => {
    const items = catalogs.slice(0, 24);
    if (items.length === 0) return [];
    const cols = Math.min(4, Math.max(2, Math.ceil(items.length / 4)));
    const rows = Math.ceil(items.length / cols);
    const colStep = (CATALOG_X_MAX - CATALOG_X_MIN) / Math.max(cols - 1, 1);
    const rowStep = (VIEW_H - 80) / Math.max(rows - 1, 1);
    return items.map((item, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      return {
        id: item.catalog_id,
        x: cols === 1 ? (CATALOG_X_MIN + CATALOG_X_MAX) / 2 : CATALOG_X_MIN + col * colStep,
        y: rows === 1 ? VIEW_H / 2 : 40 + row * rowStep,
        trust: item.trust_tier ?? 'none',
        sourceIds: item._source_registries,
      };
    });
  }, [catalogs]);

  const links = useMemo(() => {
    const regById = new Map(registryPositions.map((r) => [r.id, r]));
    const out: Array<{ id: string; x1: number; y1: number; x2: number; y2: number; delay: number }> = [];
    catalogPositions.forEach((cat, idx) => {
      cat.sourceIds.forEach((srcId) => {
        const src = regById.get(srcId);
        if (!src) return;
        out.push({
          id: `${srcId}->${cat.id}`,
          x1: src.x,
          y1: src.y,
          x2: cat.x,
          y2: cat.y,
          delay: (idx * 0.18) % 1.8,
        });
      });
    });
    return out;
  }, [catalogPositions, registryPositions]);

  const headlineCopy = locale === 'zh' ? '协议拓扑实况' : 'Protocol topology · live';
  const empty = registries.length === 0;

  return (
    <div className="directory-topology relative overflow-hidden rounded-md border border-white/10 bg-[#05070a] text-white">
      <div className="absolute inset-0" aria-hidden>
        <div className="directory-topology-grid" />
        <div className="directory-topology-glow" />
      </div>

      <div className="relative grid gap-4 px-6 pt-5 sm:grid-cols-[1fr_auto] sm:px-8 sm:pt-7">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-white/14 bg-white/8 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--ocp-cyan)]">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--ocp-cyan)] shadow-[0_0_10px_var(--ocp-cyan)]" />
            {headlineCopy}
          </div>
          <h2 className="mt-3 max-w-xl text-2xl font-semibold leading-tight sm:text-3xl">
            {locale === 'zh'
              ? '注册节点 × Catalog · 联邦发现网络'
              : 'Registration nodes × catalogs · the federated discovery mesh'}
          </h2>
        </div>

        <dl className="grid grid-cols-2 gap-2 text-right sm:grid-cols-4">
          <Stat label={locale === 'zh' ? '注册节点' : 'Registries'} value={`${stats.registriesLive}/${stats.registriesTotal}`} />
          <Stat label={locale === 'zh' ? 'Catalogs' : 'Catalogs'} value={stats.registriesLive > 0 ? String(stats.catalogsTotal) : '—'} />
          <Stat
            label={locale === 'zh' ? '已验证' : 'Verified'}
            value={stats.registriesLive > 0 ? `${Math.round(stats.verifiedRatio * 100)}%` : '—'}
            tone="cyan"
          />
          <Stat
            label={locale === 'zh' ? '健康' : 'Healthy'}
            value={stats.registriesLive > 0 ? `${Math.round(stats.healthyRatio * 100)}%` : '—'}
            tone="green"
          />
        </dl>
      </div>

      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className="relative mt-2 block h-[260px] w-full sm:h-[300px]"
        role="img"
        aria-label={locale === 'zh' ? '协议拓扑图' : 'Protocol topology diagram'}
      >
        <defs>
          <linearGradient id="dir-link-grad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="rgba(0, 222, 218, 0.0)" />
            <stop offset="38%" stopColor="rgba(0, 222, 218, 0.42)" />
            <stop offset="100%" stopColor="rgba(0, 222, 218, 0.0)" />
          </linearGradient>
          <radialGradient id="dir-node-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(0, 222, 218, 0.55)" />
            <stop offset="60%" stopColor="rgba(0, 222, 218, 0.12)" />
            <stop offset="100%" stopColor="rgba(0, 222, 218, 0)" />
          </radialGradient>
        </defs>

        {links.map((link) => (
          <g key={link.id}>
            <line
              x1={link.x1}
              y1={link.y1}
              x2={link.x2}
              y2={link.y2}
              stroke="url(#dir-link-grad)"
              strokeWidth={1.2}
              strokeLinecap="round"
            />
            <circle r={2.6} fill="var(--ocp-cyan)" className="directory-topology-pulse">
              <animateMotion
                dur="3.4s"
                begin={`${link.delay}s`}
                repeatCount="indefinite"
                path={`M ${link.x1} ${link.y1} L ${link.x2} ${link.y2}`}
              />
              <animate
                attributeName="opacity"
                values="0;1;1;0"
                keyTimes="0;0.1;0.9;1"
                dur="3.4s"
                begin={`${link.delay}s`}
                repeatCount="indefinite"
              />
            </circle>
          </g>
        ))}

        {registryPositions.map((reg) => (
          <g key={reg.id} transform={`translate(${reg.x}, ${reg.y})`}>
            <circle r={28} fill="url(#dir-node-glow)" opacity={reg.live ? 1 : 0.3} />
            <circle
              r={11}
              fill="#05070a"
              stroke={reg.live ? 'var(--ocp-cyan)' : 'rgba(255,255,255,0.32)'}
              strokeWidth={1.5}
            />
            <circle r={4.5} fill={reg.live ? 'var(--ocp-cyan)' : 'rgba(255,255,255,0.42)'}>
              {reg.live && (
                <animate attributeName="opacity" values="0.6;1;0.6" dur="2.4s" repeatCount="indefinite" />
              )}
            </circle>
            <text
              x={-22}
              y={5}
              textAnchor="end"
              fill="rgba(255,255,255,0.62)"
              fontSize={11}
              fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
              letterSpacing="0.04em"
            >
              {reg.id}
            </text>
          </g>
        ))}

        {catalogPositions.map((cat) => (
          <g key={cat.id} transform={`translate(${cat.x}, ${cat.y})`}>
            <rect
              x={-8}
              y={-8}
              width={16}
              height={16}
              rx={2}
              fill={trustColor[cat.trust] ?? trustColor.none}
              opacity={0.94}
            />
            <rect
              x={-8}
              y={-8}
              width={16}
              height={16}
              rx={2}
              fill="none"
              stroke="rgba(255,255,255,0.18)"
              strokeWidth={1}
            />
          </g>
        ))}

        {empty && (
          <text
            x={VIEW_W / 2}
            y={VIEW_H / 2}
            textAnchor="middle"
            fill="rgba(255,255,255,0.42)"
            fontSize={14}
          >
            {locale === 'zh' ? '尚未配置注册节点。' : 'No registration nodes configured.'}
          </text>
        )}
      </svg>

      {/* Legend */}
      <div className="relative flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-white/10 px-6 py-3 text-[11px] text-white/64 sm:px-8">
        <LegendDot color="var(--ocp-cyan)" label="authority" />
        <LegendDot color="var(--ocp-green)" label="verified_domain" />
        <LegendDot color="var(--ocp-gold)" label="declared" />
        <LegendDot color="rgba(255,255,255,0.42)" label="none" />
        <span className="ml-auto font-mono text-[10px] uppercase tracking-wider text-white/40">
          {locale === 'zh' ? '左：注册节点 · 右：catalog 单元' : 'left: registries · right: catalog units'}
        </span>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'cyan' | 'green';
}) {
  const color = tone === 'cyan' ? 'var(--ocp-cyan)' : tone === 'green' ? 'var(--ocp-green)' : '#f4f5f2';
  return (
    <div>
      <dt className="text-[10px] font-semibold uppercase tracking-[0.12em] text-white/52">{label}</dt>
      <dd className="font-mono text-xl font-semibold tabular-nums" style={{ color } as CSSProperties}>
        {value}
      </dd>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="h-2 w-2 rounded-sm" style={{ background: color }} />
      <span className="font-mono uppercase tracking-wider">{label}</span>
    </span>
  );
}
