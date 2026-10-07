import { OcpClient, validateCatalogQueryRequest } from '@ocp-catalog/ocp-client';
import {
  catalogManifestSchema, catalogQueryRequestSchema, catalogQueryResultSchema, inventoryPackSchema,
  pricePackSchema, resolvableReferenceSchema, resolveRequestSchema,
  type CatalogManifest, type CatalogQueryRequest, type ResolveRequest,
} from '@ocp-catalog/ocp-schema';
import { FlowError } from './errors';
import { ocpAmountToMinor, trustedUrl } from './validation';
import type { Intent } from './types';

export interface CatalogConfig {
  origin: string;
  catalogId: string;
  manifestUrl: string;
  discoveryUrl?: string;
  checkoutActionId: string; // Must be supplied by the agreed merchant contract, never inferred.
  fetch?: typeof fetch;
}

/** Reuses the OcpClient API/schema with an A-side redirect-refusing read transport.
 * No API key, authorization proof, cookie, or payment secret is accepted here.
 */
class GuardedReadClient extends OcpClient {
  constructor(private readonly origin: string, private readonly fetcher: typeof fetch = fetch) { super(); }
  async read(url: string, paths: readonly string[], body?: unknown): Promise<unknown> {
    const endpoint = trustedUrl(url, this.origin, paths);
    const response = await this.fetcher(endpoint, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      credentials: 'omit', signal: AbortSignal.timeout(5000),
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new FlowError('catalog_unavailable', '目录请求未成功。', 503);
    return response.json();
  }
  override async inspectCatalog(url: string) { return catalogManifestSchema.parse(await this.read(url, ['/ocp/manifest'])); }
  override async queryCatalog(url: string, body: CatalogQueryRequest) {
    return catalogQueryResultSchema.parse(await this.read(url, ['/ocp/query'], catalogQueryRequestSchema.parse(body)));
  }
  override async resolveCatalogEntry(url: string, body: ResolveRequest) {
    return resolvableReferenceSchema.parse(await this.read(url, ['/ocp/resolve'], resolveRequestSchema.parse(body)));
  }
}

/** Reads declared OCP catalog capabilities before the commerce confirmation flow. */
export class OcpConsumer {
  private readonly client: GuardedReadClient;
  private manifest?: CatalogManifest;
  private knownEntries = new Set<string>();
  constructor(private readonly config: CatalogConfig) {
    this.client = new GuardedReadClient(config.origin, config.fetch);
    trustedUrl(config.manifestUrl, config.origin, ['/ocp/manifest']);
  }
  async inspect(): Promise<CatalogManifest> {
    if (this.config.discoveryUrl) {
      const discovery = await this.client.read(this.config.discoveryUrl, ['/.well-known/ocp-catalog']) as Record<string, unknown>;
      // The existing package has no well-known discovery schema; validate consumed identity/URL fields explicitly.
      if (discovery?.kind !== 'WellKnownCatalogDiscovery' || discovery.ocp_version !== '1.0'
        || discovery.catalog_id !== this.config.catalogId || discovery.manifest_url !== this.config.manifestUrl) {
        throw new FlowError('catalog_mismatch', '发现信息与预配置目录不一致。');
      }
    }
    const manifest = await this.client.inspectCatalog(this.config.manifestUrl);
    if (manifest.catalog_id !== this.config.catalogId) throw new FlowError('catalog_mismatch', '目录身份不匹配。');
    trustedUrl(manifest.endpoints.query.url, this.config.origin, ['/ocp/query']);
    trustedUrl(manifest.endpoints.resolve.url, this.config.origin, ['/ocp/resolve']);
    if (manifest.endpoints.query.method !== 'POST' || manifest.endpoints.resolve.method !== 'POST') {
      throw new FlowError('unsupported_capability', '目录没有声明需要的 POST 能力。');
    }
    this.manifest = manifest; return manifest;
  }
  async search(intent: Intent) {
    const manifest = this.manifest ?? await this.inspect();
    const desired = { currency: intent.currency, max_amount: Math.floor(intent.max_total_minor / intent.quantity) / 100, in_stock_only: true };
    const choices = manifest.query_capabilities.flatMap(capability => capability.query_packs.map(pack => {
      const fields = new Set(capability.input_fields.map(field => field.name).filter((value): value is string => typeof value === 'string'));
      const filters = Object.fromEntries(Object.entries(desired).filter(([field]) => fields.has(`filters.${field}`)));
      const hasFilters = Object.keys(filters).length > 0;
      const mode = hasFilters && pack.query_modes.includes('hybrid') ? 'hybrid' : pack.query_modes.includes('keyword') ? 'keyword' : undefined;
      // Keyword packs can accept optional, declared filters. Their mode remains
      // keyword; adding filters does not invent a hybrid capability.
      return { pack, mode, filters, capability };
    })).filter(choice => choice.mode && choice.capability.supports_resolve);
    const choice = choices.sort((left, right) => Object.keys(right.filters).length - Object.keys(left.filters).length)[0];
    if (!choice) throw new FlowError('unsupported_capability', '目录没有适用且支持 Resolve 的关键词/混合查询能力。');
    const request = catalogQueryRequestSchema.parse({
      ocp_version: '1.0', kind: 'CatalogQueryRequest', catalog_id: manifest.catalog_id,
      query: intent.query, query_pack: choice.pack.pack_id, query_mode: choice.mode,
      filters: choice.filters, limit: 20, explain: choice.capability.supports_explain,
    });
    validateCatalogQueryRequest(manifest, request, { queryUrl: manifest.endpoints.query.url });
    const matches: Awaited<ReturnType<GuardedReadClient['queryCatalog']>>['entries'] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let incomplete = false;
    // A page is not the full catalog. Follow advertised cursors so that local
    // verification can still find a qualifying item after the first 20 rows.
    for (let page = 0; page < 50; page++) {
      const pageRequest = cursor === undefined ? request : catalogQueryRequestSchema.parse({ ...request, cursor });
      const result = await this.client.queryCatalog(manifest.endpoints.query.url, pageRequest);
      if (result.catalog_id !== manifest.catalog_id || (result.query_pack && result.query_pack !== request.query_pack)
        || result.entries.some(match => match.entry.catalog_id !== manifest.catalog_id)) throw new FlowError('catalog_mismatch', '查询结果来自不同目录或 query pack。');
      matches.push(...result.entries);
      if (!result.page.has_more) break;
      const nextCursor = result.page.next_cursor;
      if (!nextCursor || cursors.has(nextCursor)) throw new FlowError('catalog_unavailable', '目录分页游标缺失或重复，无法确认完整查询结果。', 503);
      cursors.add(nextCursor); cursor = nextCursor;
      if (page === 49) incomplete = true;
    }
    const uniqueMatches = [...new Map(matches.map(match => [match.entry.entry_id, match])).values()];
    const entries = uniqueMatches.filter(({ entry }) => {
      const price = pricePackSchema.safeParse(entry.attributes.price);
      const inventory = inventoryPackSchema.safeParse(entry.attributes.inventory);
      return price.success && price.data.currency === intent.currency
        && ocpAmountToMinor(price.data.amount) * intent.quantity <= intent.max_total_minor
        && inventory.success && ['in_stock', 'low_stock'].includes(inventory.data.availability_status);
    });
    // One transport serves several A sessions. A later search must not erase
    // another session's catalog-backed candidate before that user selects it.
    for (const { entry } of entries) this.knownEntries.add(entry.entry_id);
    const missing = Object.keys(desired).filter(field => !(field in choice.filters));
    const warnings = missing.length ? [`目录未声明或未使用这些筛选，A 仅在返回结果本地复核：${missing.join(', ')}。不能宣称服务端已筛选。`] : [];
    if (incomplete) warnings.push('目录超过 50 页，已停止查询；当前候选不代表全部匹配商品。');
    return { entries, request, warnings };
  }
  async resolve(entryId: string) {
    if (!this.manifest || !this.knownEntries.has(entryId)) throw new FlowError('invalid_request', '只能 Resolve 已经从受信目录查询得到的候选。');
    const reference = await this.client.resolveCatalogEntry(this.manifest.endpoints.resolve.url, resolveRequestSchema.parse({
      catalog_id: this.manifest.catalog_id, entry_id: entryId, purpose: 'checkout', live_check: true,
    }));
    if (reference.catalog_id !== this.manifest.catalog_id || reference.entry_id !== entryId
      || Date.parse(reference.expires_at) <= Date.now()
      || (reference.access && reference.access.permission_state !== 'granted')
      || reference.live_checks.some(check => ['failed', 'unknown'].includes(check.status))) {
      throw new FlowError('resolve_unavailable', '商品引用过期、无权限或实时检查未通过。');
    }
    const binding = reference.action_bindings.find(action => action.action_id === this.config.checkoutActionId);
    if (!binding || binding.action_type !== 'api' || binding.entrypoint.method !== 'POST'
      || !binding.requires_user_confirmation || (binding.expires_at && Date.parse(binding.expires_at) <= Date.now())) {
      throw new FlowError('unsupported_capability', '目录没有声明有效且需用户确认的结账 API 入口。');
    }
    const checkoutUrl = trustedUrl(binding.entrypoint.url, this.config.origin, ['/commerce/v1/checkouts']);
    return { reference, binding, checkout_url: checkoutUrl };
  }
}
