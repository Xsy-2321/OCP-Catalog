/**
 * Regenerates every JSON fixture under `fixtures/shopping/`.
 *
 * The fixtures are committed, not generated at test time — A consumes them as
 * static files while B's server does not exist yet, which is the whole point
 * (AGENT_A.md §6.2). This script exists so that the ones carrying a hash or a
 * signature can be re-derived instead of hand-edited, which is the only way to
 * keep them honest.
 *
 * Everything here is fixed: no `new Date()`, no randomness. Two runs must
 * produce byte-identical files, and `fixtures.test.ts` fails if they drift.
 *
 * Run with:  bun fixtures/shopping/generate.ts
 */
import { createPrivateKey, sign } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AUTH_DOMAIN,
  AUTH_SCHEME,
  CHECKOUT_ACTION_ID,
  CHECKOUT_ACTION_TYPE,
  EXPECTED_FILTERABLE_FIELD_REFS,
  TERMS_DOMAIN,
  authorizationSigningBytes,
  computeTermsHash,
  type AuthorizationProof,
  type AuthorizationSignedPayload,
  type Order,
  type PurchaseAttempt,
  type Quote,
} from '../../packages/shopping-contracts/src/index';

const here = import.meta.dir;

// ---------------------------------------------------------------------------
// Fixed identities and times. Changing any of these changes every hash below.
// ---------------------------------------------------------------------------

const BASE_URL = 'http://127.0.0.1:8787';
const CATALOG_ID = 'catalog_coffee_demo';
const PROVIDER_ID = 'provider_coffee_demo';
const MERCHANT_ID = 'merchant_coffee_demo';
const USER_ID = 'user_demo_1';
const ISSUER = 'agent_a_demo';
const KEY_ID = 'agent_a_test';
const CALLER_ID = 'caller_demo_1';
const LOCATION_ID = 'store_zjg';

/** The instant the fixtures pretend "now" is. Fixed, so nothing drifts. */
const NOW = '2026-10-07T10:05:00.000Z';
const QUOTE_CREATED = '2026-10-07T10:00:00.000Z';
const QUOTE_EXPIRES = '2026-10-07T10:15:00.000Z';
const QUOTE_EXPIRED_AT = '2026-10-07T09:20:00.000Z';
const QUOTE_EXPIRED_CREATED = '2026-10-07T09:05:00.000Z';

const seconds = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

/** The user's budget for the demo purchase: 30 yuan, fees included. */
const BUDGET_MINOR = 3000;

const privateKeyPem = await Bun.file(join(here, 'keys', 'agent_a_test.private.pem')).text();
const privateKey = createPrivateKey(privateKeyPem);

/** Signs canonicalized payload bytes and returns the base64url detached signature. */
function signPayload(payload: AuthorizationSignedPayload): string {
  const signature = sign(null, authorizationSigningBytes(payload), privateKey);
  return Buffer.from(signature).toString('base64url');
}

const write = (relativePath: string, value: unknown): void => {
  const target = join(here, relativePath);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};

const writeText = (relativePath: string, text: string): void => {
  const target = join(here, relativePath);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, text, 'utf8');
};

// ---------------------------------------------------------------------------
// Catalog. Five entries chosen to cover the four cases A must handle.
// ---------------------------------------------------------------------------

type CatalogItem = {
  entry_id: string;
  title: string;
  summary: string;
  brand: string;
  category: string;
  amount: number;
  price_minor: number;
  availability_status: 'in_stock' | 'low_stock' | 'out_of_stock';
  quantity: number;
  methods: ('pickup' | 'delivery')[];
  delivery_fee_minor?: number;
  note: string;
};

const ITEMS: CatalogItem[] = [
  {
    entry_id: 'entry_latte',
    title: '拿铁',
    summary: '标准杯拿铁，中深烘拼配豆。',
    brand: '演示咖啡',
    category: 'coffee',
    amount: 25,
    price_minor: 2500,
    availability_status: 'in_stock',
    quantity: 12,
    methods: ['pickup', 'delivery'],
    delivery_fee_minor: 500,
    note: '预算内的主用例：¥25.00，外送另加 ¥5.00。',
  },
  {
    entry_id: 'entry_americano',
    title: '美式',
    summary: '标准杯美式，热饮。',
    brand: '演示咖啡',
    category: 'coffee',
    amount: 9.9,
    price_minor: 990,
    availability_status: 'in_stock',
    quantity: 30,
    methods: ['pickup'],
    note: '最便宜的一项，用来验证排序与多候选比较。',
  },
  {
    entry_id: 'entry_gift_box',
    title: '手冲礼盒',
    summary: '含滤杯、滤纸与两包单品豆。',
    brand: '演示咖啡',
    category: 'merchandise',
    amount: 88,
    price_minor: 8800,
    availability_status: 'in_stock',
    quantity: 5,
    methods: ['pickup'],
    note: '超预算用例：¥88.00 远超 ¥30.00 预算，必须被真实拒绝。',
  },
  {
    entry_id: 'entry_soldout',
    title: '脏脏咖啡',
    summary: '季节性特调，今日已售完。',
    brand: '演示咖啡',
    category: 'coffee',
    amount: 28,
    price_minor: 2800,
    availability_status: 'out_of_stock',
    quantity: 0,
    methods: ['pickup'],
    note: '缺货用例：即使有货也会在预算内，但必须因为库存被拒绝。',
  },
  {
    entry_id: 'entry_cold_brew',
    title: '冷萃',
    summary: '十二小时冷萃，仅剩最后一杯。',
    brand: '演示咖啡',
    category: 'coffee',
    amount: 30,
    price_minor: 3000,
    availability_status: 'low_stock',
    quantity: 1,
    methods: ['pickup'],
    note: '低库存用例：恰好等于预算，且数量只剩 1 —— 并发下单的边界。',
  },
];

/** The OCP `CatalogEntry` shape, with the demo attribute pack alongside. */
function toCatalogEntry(item: CatalogItem) {
  return {
    kind: 'CatalogEntry',
    catalog_id: CATALOG_ID,
    entry_id: item.entry_id,
    provider_id: PROVIDER_ID,
    object_id: `obj_${item.entry_id}`,
    object_type: 'ocp.commerce.product',
    title: item.title,
    summary: item.summary,
    attributes: {
      brand: item.brand,
      category: item.category,
      // The existing OCP price pack keeps decimal major units — unchanged.
      price: { currency: 'CNY', amount: item.amount, price_type: 'fixed' },
      // The same price in integer minor units, for the commerce flow.
      price_minor: item.price_minor,
      inventory: { availability_status: item.availability_status, quantity: item.quantity },
      fulfillment: {
        methods: item.methods,
        ...(item.delivery_fee_minor === undefined
          ? {}
          : { delivery_fee_minor: item.delivery_fee_minor }),
      },
    },
  };
}

write(
  'catalog.coffee.json',
  ITEMS.map((item) => ({ ...toCatalogEntry(item), _fixture_note: item.note })),
);

// ---------------------------------------------------------------------------
// OCP read endpoints. A develops against these before B's server exists.
// ---------------------------------------------------------------------------

write('discovery.json', {
  ocp_version: '1.0',
  kind: 'WellKnownCatalogDiscovery',
  catalog_id: CATALOG_ID,
  catalog_name: '演示咖啡（本地模拟）',
  manifest_url: `${BASE_URL}/ocp/manifest`,
  health_url: `${BASE_URL}/ocp/health`,
  query_url: `${BASE_URL}/ocp/query`,
  resolve_url: `${BASE_URL}/ocp/resolve`,
});

write('manifest.json', {
  ocp_version: '1.0',
  kind: 'CatalogManifest',
  id: `manifest_${CATALOG_ID}`,
  catalog_id: CATALOG_ID,
  catalog_name: '演示咖啡（本地模拟）',
  description: '本地演示咖啡店。付款为本地模拟，不接任何真实支付。',
  registry_visibility: 'public',
  endpoints: {
    health: { url: `${BASE_URL}/ocp/health`, method: 'GET' },
    query: { url: `${BASE_URL}/ocp/query`, method: 'POST' },
    resolve: { url: `${BASE_URL}/ocp/resolve`, method: 'POST' },
  },
  query_capabilities: [
    {
      capability_id: 'ocp.demo.coffee.search.v1',
      name: 'Coffee catalog keyword search',
      description: 'Case-insensitive keyword match over title, summary, brand and category.',
      query_packs: [
        {
          pack_id: 'ocp.query.keyword.v1',
          description: 'Keyword search with optional filters.',
          query_modes: ['keyword'],
          metadata: {},
        },
      ],
      searchable_field_refs: ['product.core#/title', 'product.core#/brand', 'product.core#/category'],
      // Derived from the map, never listed by hand: the manifest may only
      // declare a filter the merchant actually implements.
      filterable_field_refs: [...EXPECTED_FILTERABLE_FIELD_REFS],
      sortable_field_refs: [],
      supports_explain: true,
      supports_resolve: true,
      metadata: {},
    },
  ],
  // Declared, and each one is actually implemented. The filter schema is strict,
  // so anything not declared here would be rejected at the boundary.
  object_contracts: [],
});

write('health.json', {
  ocp_version: '1.0',
  kind: 'CatalogHealth',
  catalog_id: CATALOG_ID,
  status: 'healthy',
  ready: true,
  checked_at: NOW,
  details: {},
  dependencies: [],
});

write('query-result.json', {
  ocp_version: '1.0',
  kind: 'CatalogQueryResult',
  id: 'qry_fixture_latte',
  catalog_id: CATALOG_ID,
  query_pack: 'ocp.query.keyword.v1',
  query_mode: 'keyword',
  query: '拿铁',
  result_count: 1,
  page: { limit: 20, offset: 0, has_more: false },
  entries: [
    {
      entry: toCatalogEntry(ITEMS[0]!),
      score: 1,
      explain: ['Keyword match for "拿铁".'],
    },
  ],
  policy_summary: {
    selected_capability_id: 'ocp.demo.coffee.search.v1',
    selected_query_pack: 'ocp.query.keyword.v1',
    query_mode: 'keyword',
    supports_explain: true,
    accepted_filters: [],
    rejected_filters: [],
    warnings: [],
  },
  explain: [],
});

write('resolve.json', {
  ocp_version: '1.0',
  kind: 'ResolvableReference',
  id: 'res_fixture_latte',
  catalog_id: CATALOG_ID,
  entry_id: 'entry_latte',
  commercial_object_id: 'co_entry_latte',
  object_id: 'obj_entry_latte',
  object_type: 'ocp.commerce.product',
  provider_id: PROVIDER_ID,
  title: '拿铁',
  visible_attributes: {
    brand: '演示咖啡',
    category: 'coffee',
    price: { currency: 'CNY', amount: 25 },
    price_minor: 2500,
    availability_status: 'in_stock',
    fulfillment: { methods: ['pickup', 'delivery'], delivery_fee_minor: 500 },
  },
  access: { visibility: 'public', permission_state: 'granted', redacted_fields: [], policy_notes: [] },
  live_checks: [
    {
      check_id: 'lc_fixture_1',
      status: 'passed',
      checked_at: NOW,
      summary: 'Stock and price confirmed against the merchant.',
      details: {},
    },
  ],
  action_bindings: [
    {
      action_id: 'view',
      action_type: 'url',
      label: '打开商品页',
      entrypoint: { url: `${BASE_URL}/products/entry_latte`, method: 'GET' },
      auth_requirements: {},
      requires_user_confirmation: false,
    },
    {
      // A reads the checkout endpoint from here rather than constructing it.
      action_id: CHECKOUT_ACTION_ID,
      action_type: CHECKOUT_ACTION_TYPE,
      label: '结账',
      description: '提交报价与用户授权证明，发起一次购买尝试。',
      entrypoint: { url: `${BASE_URL}/commerce/v1/checkouts`, method: 'POST' },
      input_schema: {
        required: ['purchase_attempt_id', 'quote_id', 'terms_hash', 'authorization'],
        headers: {
          'idempotency-key': 'stable across retries of the same logical purchase',
          'x-dev-caller-id': 'local development caller identity — not an account system',
        },
      },
      auth_requirements: { scheme: AUTH_SCHEME, key_id: KEY_ID },
      requires_user_confirmation: true,
      expires_at: QUOTE_EXPIRES,
    },
  ],
  freshness: { object_updated_at: QUOTE_CREATED, resolved_at: NOW },
  expires_at: QUOTE_EXPIRES,
});

// ---------------------------------------------------------------------------
// Quotes.
// ---------------------------------------------------------------------------

/** Builds a quote and its server-computed terms_hash from a draft. */
function buildQuote(draft: Omit<Quote, 'terms_hash'>): Quote {
  const termsHash = computeTermsHash({
    v: TERMS_DOMAIN,
    merchant_id: draft.merchant_id,
    quote_id: draft.quote_id,
    currency: draft.currency,
    total_minor: draft.total_minor,
    items: draft.items.map((i) => ({
      entry_id: i.entry_id,
      quantity: i.quantity,
      unit_minor: i.unit_minor,
    })),
    fees: draft.fees.map((f) => ({ code: f.code, amount_minor: f.amount_minor })),
    fulfillment: draft.fulfillment,
  });
  return { ...draft, terms_hash: termsHash };
}

const validQuote = buildQuote({
  quote_id: 'quote_fixture_latte_pickup',
  merchant_id: MERCHANT_ID,
  catalog_id: CATALOG_ID,
  currency: 'CNY',
  items: [
    {
      entry_id: 'entry_latte',
      title: '拿铁',
      quantity: 1,
      unit_minor: 2500,
      line_total_minor: 2500,
    },
  ],
  fees: [],
  subtotal_minor: 2500,
  total_minor: 2500,
  fulfillment: { method: 'pickup', location_id: LOCATION_ID },
  created_at: QUOTE_CREATED,
  expires_at: QUOTE_EXPIRES,
});

const deliveryQuote = buildQuote({
  quote_id: 'quote_fixture_latte_delivery',
  merchant_id: MERCHANT_ID,
  catalog_id: CATALOG_ID,
  currency: 'CNY',
  items: [
    {
      entry_id: 'entry_latte',
      title: '拿铁',
      quantity: 1,
      unit_minor: 2500,
      line_total_minor: 2500,
    },
  ],
  fees: [{ code: 'delivery', label: '配送费', amount_minor: 500 }],
  subtotal_minor: 2500,
  total_minor: 3000,
  fulfillment: { method: 'delivery', location_id: LOCATION_ID },
  created_at: QUOTE_CREATED,
  expires_at: QUOTE_EXPIRES,
});

const expiredQuote = buildQuote({
  ...validQuote,
  quote_id: 'quote_fixture_latte_expired',
  created_at: QUOTE_EXPIRED_CREATED,
  expires_at: QUOTE_EXPIRED_AT,
});

const overBudgetQuote = buildQuote({
  quote_id: 'quote_fixture_giftbox',
  merchant_id: MERCHANT_ID,
  catalog_id: CATALOG_ID,
  currency: 'CNY',
  items: [
    {
      entry_id: 'entry_gift_box',
      title: '手冲礼盒',
      quantity: 1,
      unit_minor: 8800,
      line_total_minor: 8800,
    },
  ],
  fees: [],
  subtotal_minor: 8800,
  total_minor: 8800,
  fulfillment: { method: 'pickup', location_id: LOCATION_ID },
  created_at: QUOTE_CREATED,
  expires_at: QUOTE_EXPIRES,
});

write('quotes/valid.json', validQuote);
write('quotes/valid-delivery.json', deliveryQuote);
write('quotes/expired.json', expiredQuote);
write('quotes/over-budget.json', overBudgetQuote);

// ---------------------------------------------------------------------------
// Authorizations. One valid, five ways to be rejected.
// ---------------------------------------------------------------------------

const VALID_ATTEMPT_ID = 'att_fixture_0001';

const validPayload: AuthorizationSignedPayload = {
  v: AUTH_DOMAIN,
  issuer: ISSUER,
  user_id: USER_ID,
  merchant_id: MERCHANT_ID,
  quote_id: validQuote.quote_id,
  terms_hash: validQuote.terms_hash,
  currency: 'CNY',
  max_total_minor: BUDGET_MINOR,
  purchase_attempt_id: VALID_ATTEMPT_ID,
  issued_at: seconds(QUOTE_CREATED),
  expires_at: seconds(QUOTE_EXPIRES),
  jti: 'jti_fixture_0001',
};

const proofOf = (payload: AuthorizationSignedPayload, signature?: string): AuthorizationProof => ({
  scheme: AUTH_SCHEME,
  key_id: KEY_ID,
  signature: signature ?? signPayload(payload),
  payload,
});

write('authorization/valid.json', proofOf(validPayload));

// Signed correctly, but its own window has already closed. The signature still
// verifies, so the rejection must come from the expiry check, not from the key.
write(
  'authorization/expired.json',
  proofOf({
    ...validPayload,
    purchase_attempt_id: 'att_fixture_0002',
    jti: 'jti_fixture_0002',
    issued_at: seconds('2026-10-07T08:00:00.000Z'),
    expires_at: seconds('2026-10-07T08:15:00.000Z'),
  }),
);

// Correctly signed over a different merchant: the signature is valid for *this*
// payload, so only the merchant_id comparison can reject it.
write(
  'authorization/wrong-merchant.json',
  proofOf({
    ...validPayload,
    merchant_id: 'merchant_other_demo',
    purchase_attempt_id: 'att_fixture_0003',
    jti: 'jti_fixture_0003',
  }),
);

// Correctly signed over a different terms_hash: the quote has changed under the
// authorization, so checkout must answer `requote_required`.
write(
  'authorization/wrong-terms-hash.json',
  proofOf({
    ...validPayload,
    terms_hash: 'f'.repeat(64),
    purchase_attempt_id: 'att_fixture_0004',
    jti: 'jti_fixture_0004',
  }),
);

// A genuine signature, then one base64url character changed. This is the case a
// verifier that compares length instead of verifying bytes would let through.
const genuineSignature = signPayload(validPayload);
const corruptedSignature = `${genuineSignature.slice(0, -1)}${genuineSignature.at(-1) === 'A' ? 'B' : 'A'}`;

write(
  'authorization/tampered-signature.json',
  proofOf({ ...validPayload, jti: 'jti_fixture_0005' }, corruptedSignature),
);

// The replay case: a signature that was valid for att_fixture_0001, presented
// under a different attempt id. The payload was edited after signing, so the
// bytes no longer match — this must fail with `authorization_invalid`.
write(
  'authorization/replayed-other-attempt.json',
  proofOf(
    {
      ...validPayload,
      purchase_attempt_id: 'att_fixture_0006',
      jti: 'jti_fixture_0006',
    },
    genuineSignature,
  ),
);

/** The exact body A sends to `POST /commerce/v1/checkouts`. */
const checkoutBody = (proof: AuthorizationProof, attemptId: string) => ({
  purchase_attempt_id: attemptId,
  quote_id: validQuote.quote_id,
  terms_hash: validQuote.terms_hash,
  authorization: proof,
});

write(
  'checkouts/request-valid.json',
  {
    _headers: { 'idempotency-key': 'idem_fixture_demo_0001', 'x-dev-caller-id': CALLER_ID },
    _body: checkoutBody(proofOf(validPayload), VALID_ATTEMPT_ID),
  },
);

// The forbidden shortcut, spelled out so A can see exactly what will be refused.
write('checkouts/request-without-proof.json', {
  _headers: { 'idempotency-key': 'idem_fixture_demo_0002', 'x-dev-caller-id': CALLER_ID },
  _body: {
    purchase_attempt_id: 'att_fixture_0007',
    quote_id: validQuote.quote_id,
    terms_hash: validQuote.terms_hash,
    approved: true,
  },
  _expected_error: {
    code: 'invalid_request',
    note: '`approved: true` is not authorization. The request must carry a proof.',
  },
});

// ---------------------------------------------------------------------------
// Attempts and orders. Both state machines, including the timeout case.
// ---------------------------------------------------------------------------

const attempts: Record<string, PurchaseAttempt> = {
  processing: {
    purchase_attempt_id: VALID_ATTEMPT_ID,
    merchant_id: MERCHANT_ID,
    quote_id: validQuote.quote_id,
    catalog_id: CATALOG_ID,
    status: 'processing',
    created_at: NOW,
    updated_at: NOW,
  },
  confirmed: {
    purchase_attempt_id: VALID_ATTEMPT_ID,
    merchant_id: MERCHANT_ID,
    quote_id: validQuote.quote_id,
    catalog_id: CATALOG_ID,
    status: 'confirmed',
    order_id: 'ord_fixture_0001',
    created_at: NOW,
    updated_at: '2026-10-07T10:05:04.000Z',
  },
  failed: {
    purchase_attempt_id: 'att_fixture_0009',
    merchant_id: MERCHANT_ID,
    quote_id: validQuote.quote_id,
    catalog_id: CATALOG_ID,
    status: 'failed',
    error: { code: 'payment_failed', message: '本地模拟支付被拒绝。' },
    created_at: NOW,
    updated_at: '2026-10-07T10:05:04.000Z',
  },
};

for (const [name, attempt] of Object.entries(attempts)) {
  write(`attempts/${name}.json`, attempt);
}

/** Shared order shape; each variant below changes only its status fields. */
function makeOrder(overrides: Partial<Order>): Order {
  return {
    order_id: 'ord_fixture_0001',
    merchant_id: MERCHANT_ID,
    catalog_id: CATALOG_ID,
    purchase_attempt_id: VALID_ATTEMPT_ID,
    quote_id: validQuote.quote_id,
    currency: 'CNY',
    items: validQuote.items,
    fees: validQuote.fees,
    subtotal_minor: validQuote.subtotal_minor,
    total_minor: validQuote.total_minor,
    terms_hash: validQuote.terms_hash,
    fulfillment: validQuote.fulfillment,
    created_at: '2026-10-07T10:05:04.000Z',
    updated_at: '2026-10-07T10:05:04.000Z',
    ...overrides,
  };
}

write(
  'orders/confirmed.json',
  makeOrder({
    payment_status: { status: 'paid', updated_at: '2026-10-07T10:05:04.000Z' },
    fulfillment_status: { status: 'pending', updated_at: '2026-10-07T10:05:04.000Z' },
  }),
);

// The timeout case: money may or may not have moved, so payment is `unknown`
// and no order id is claimed. A caller must keep polling, not retry.
write(
  'orders/processing.json',
  makeOrder({
    order_id: 'ord_fixture_0002',
    purchase_attempt_id: 'att_fixture_0008',
    payment_status: { status: 'unknown', updated_at: NOW },
    fulfillment_status: { status: 'pending', updated_at: NOW },
    created_at: NOW,
    updated_at: NOW,
  }),
);

write(
  'orders/failed.json',
  makeOrder({
    order_id: 'ord_fixture_0003',
    purchase_attempt_id: 'att_fixture_0009',
    payment_status: { status: 'failed', updated_at: '2026-10-07T10:05:04.000Z' },
    fulfillment_status: { status: 'cancelled', updated_at: '2026-10-07T10:05:04.000Z' },
  }),
);

// ---------------------------------------------------------------------------
// The failure-injection catalogue (D9), for Phase 2 to implement.
// ---------------------------------------------------------------------------

write('faults.json', {
  _note:
    'Phase 2 implements these only when MERCHANT_TEST_MODE=1. Outside test mode none of them are reachable.',
  faults: {
    payment_timeout_then_succeed: {
      effect: 'Checkout exceeds its own deadline, returns 202 processing, and settles paid on a later poll.',
      exercises: 'The timeout must not be reported as a failure.',
    },
    payment_declined: {
      effect: 'Mock payment fails. Attempt becomes failed, no order is created.',
      exercises: 'No `paid` or `confirmed` state may appear on a failed payment.',
    },
    price_raised_after_quote: {
      effect: 'The catalog price changes between quote and checkout.',
      exercises: 'terms_hash mismatch -> requote_required, not a silent charge of the new price.',
    },
    stock_exhausted_after_quote: {
      effect: 'The last unit sells to someone else between quote and checkout.',
      exercises: 'out_of_stock at checkout, and no order.',
    },
    response_dropped_after_settlement: {
      effect: 'Payment settles and the order is created, but the response never reaches the caller.',
      exercises: 'Repeating with the same Idempotency-Key returns the original order; no second payment.',
    },
  },
});

writeText(
  'keys/README.md',
  [
    '# Test keys',
    '',
    '`agent_a_test.public.pem` is committed on purpose. It is the key B configures as',
    'trusted, so that fixtures can carry signatures B will accept.',
    '',
    'The private half is derived from a **committed, public seed** — see the banner in',
    '`derive-test-keys.ts`. It protects nothing. Do not copy this arrangement for a real',
    'deployment: there, the keypair comes from a CSPRNG and the private half never enters',
    'the repository.',
    '',
    '`agent_a_test.private.pem` is written locally by `derive-test-keys.ts` and is ignored',
    'by `.gitignore` in this directory.',
    '',
  ].join('\n'),
);
