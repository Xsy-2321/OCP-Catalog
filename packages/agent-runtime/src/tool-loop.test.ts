import { describe, expect, test } from 'bun:test';
import { computeTermsHash, quoteTermsSchema, TERMS_DOMAIN } from '@ocp-catalog/shopping-contracts';
import { ShoppingCoordinator } from './coordinator';
import { FlowError } from './errors';
import { hasUntriedQuote, quoteFingerprint, runToolLoop, type Planner, type PlannerStep } from './tool-loop';
import type { AuthorizationIssuer } from './authorization';
import type { Candidate, Intent, MerchantPort, PublicSession, Session, SessionStore } from './types';

const origin = 'http://127.0.0.1:4401';
const intent: Intent = { query: '咖啡', items: [{ query: '咖啡', quantity: 1 }], quantity: 1, currency: 'CNY', max_total_minor: 1000,
  merchant_id: 'coffee-demo', fulfillment: 'pickup' };
const candidates: Candidate[] = [
  { entry_id: 'coffee_with_fee', catalog_id: 'local_catalog', merchant_id: 'coffee-demo', title: '第一款咖啡',
    description: '最终报价含附加费用', search_price_minor: 900, currency: 'CNY', in_stock: true },
  { entry_id: 'coffee_alternative', catalog_id: 'local_catalog', merchant_id: 'coffee-demo', title: '另一款咖啡',
    description: '可供用户选择的替代候选', search_price_minor: 800, currency: 'CNY', in_stock: true },
  { entry_id: 'coffee_third', catalog_id: 'local_catalog', merchant_id: 'coffee-demo', title: '第三款咖啡',
    description: '其他候选', search_price_minor: 700, currency: 'CNY', in_stock: true },
];

class MemoryStore implements SessionStore {
  readonly sessions = new Map<string, Session>();
  async read(id: string) { const value = this.sessions.get(id); return value && structuredClone(value); }
  async write(session: Session) { this.sessions.set(session.id, structuredClone(session)); }
  async listForUser(userId: string) {
    return [...this.sessions.values()].filter(value => value.user_id === userId).map(value => structuredClone(value));
  }
}

function setup() {
  const store = new MemoryStore();
  let authorizations = 0, checkouts = 0, searches = 0;
  const quotes: string[] = [];
  const issuer: AuthorizationIssuer = { issuer: 'test-issuer', issue() { authorizations++; throw new Error('planner cannot sign'); } };
  const merchant: MerchantPort = {
    mode: 'mock',
    async search() { searches++; return structuredClone(candidates); },
    async resolve() { return { checkout_url: `${origin}/commerce/v1/checkouts`, expires_at: new Date(Date.now() + 60_000).toISOString() }; },
    async quote(userId, candidate, requested) {
      quotes.push(candidate.entry_id);
      const fee = candidate.entry_id === 'coffee_with_fee' ? 200 : 100;
      return { quote_id: `quote_${crypto.randomUUID()}`, user_id: userId, merchant_id: candidate.merchant_id,
        catalog_id: candidate.catalog_id, entry_id: candidate.entry_id, title: candidate.title,
        quantity: requested.quantity, fulfillment: requested.fulfillment, currency: requested.currency,
        unit_price_minor: candidate.search_price_minor, fees: [{ label: '服务费', amount_minor: fee }],
        total_minor: candidate.search_price_minor * requested.quantity + fee,
        terms_hash: `terms_${candidate.entry_id}`, expires_at: new Date(Date.now() + 60_000).toISOString() };
    },
    async checkout() { checkouts++; throw new Error('planner cannot checkout'); },
    async getAttempt() { throw new Error('planner cannot recover'); },
    async getOrder() { throw new Error('planner cannot read orders'); },
  };
  const coordinator = new ShoppingCoordinator(merchant, store, issuer, origin);
  return { coordinator, store, merchant, quotes, diagnostics: () => ({ authorizations, checkouts, searches }) };
}

function scripted(steps: PlannerStep[]) {
  const contexts: Parameters<Planner['next']>[0][] = [];
  const planner: Planner = { mode: 'llm', async next(context) {
    contexts.push(structuredClone(context));
    const next = steps[contexts.length - 1];
    if (!next) throw new Error('unexpected extra model request');
    return next;
  } };
  return { planner, contexts };
}
const search: PlannerStep = { type: 'tool', tool: { name: 'search' } };
const quote = (entry_id: string): PlannerStep => ({ type: 'tool', tool: { name: 'quote', entry_id } });
const basketQuote = (entry_ids: string[]): PlannerStep => ({ type: 'tool', tool: { name: 'quote', entry_ids } });
const wait: PlannerStep = { type: 'wait_for_user' };
async function created(coordinator: ShoppingCoordinator) { return coordinator.create('alice', intent); }
function expectNoPurchase(runtime: ReturnType<typeof setup>, session: PublicSession) {
  expect(session.attempt).toBeUndefined();
  expect(runtime.diagnostics()).toMatchObject({ authorizations: 0, checkouts: 0 });
}

describe('bounded pre-purchase tool selection', () => {
  test('an empty successful search stops without another model request, including on the last step', async () => {
    for (const maxSteps of [1, 4]) {
      const runtime = setup();
      runtime.merchant.search = async () => [];
      const session = await created(runtime.coordinator);
      const { planner, contexts } = scripted([search]);
      const result = await runToolLoop(runtime.coordinator, 'alice', session.id, planner, { maxSteps });
      expect(result.session.phase).toBe('candidates');
      expect(result.session.candidates).toEqual([]);
      expect(result.tool_calls).toBe(1);
      expect(contexts).toHaveLength(1);
      expectNoPurchase(runtime, result.session);
    }
  });

  test('a quote on the final permitted tool returns the confirmable quote normally', async () => {
    const runtime = setup(), session = await created(runtime.coordinator);
    const { planner, contexts } = scripted([search, quote('coffee_alternative')]);
    const result = await runToolLoop(runtime.coordinator, 'alice', session.id, planner, { maxSteps: 2 });
    expect(result.session.phase).toBe('awaiting_confirmation');
    expect(result.session.quote!.total_minor).toBe(900);
    expect(result.tool_calls).toBe(2);
    expect(contexts).toHaveLength(2);
    expectNoPurchase(runtime, result.session);
  });

  test('all-in fees exceeding budget reach the planner and allow an affordable alternative', async () => {
    const runtime = setup(), session = await created(runtime.coordinator);
    const { planner, contexts } = scripted([search, quote('coffee_with_fee'), quote('coffee_alternative')]);
    const result = await runToolLoop(runtime.coordinator, 'alice', session.id, planner, { maxSteps: 3 });
    expect(contexts[2]!.session.error!.code).toBe('budget_exceeded');
    expect(contexts[2]!.history[1]!.error!.code).toBe('budget_exceeded');
    expect(contexts[2]!.session.quote!.total_minor).toBe(1100);
    expect(result.session.phase).toBe('awaiting_confirmation');
    expect(result.session.quote!.entry_id).toBe('coffee_alternative');
    expect(result.session.error).toBeUndefined();
    expect(runtime.quotes).toEqual(['coffee_with_fee', 'coffee_alternative']);
    expectNoPurchase(runtime, result.session);
  });

  test.each(['out_of_stock', 'quote_expired', 'requote_required'])('%s before purchase permits another candidate', async code => {
    const runtime = setup(), originalQuote = runtime.merchant.quote.bind(runtime.merchant);
    runtime.merchant.quote = async (...args) => {
      if (args[1].entry_id === 'coffee_with_fee') throw new FlowError(code, '候选当前不可购买。');
      return originalQuote(...args);
    };
    const session = await created(runtime.coordinator);
    const { planner, contexts } = scripted([search, quote('coffee_with_fee'), quote('coffee_alternative')]);
    const result = await runToolLoop(runtime.coordinator, 'alice', session.id, planner, { maxSteps: 3 });
    expect(contexts[2]!.history[1]!.error!.code).toBe(code);
    expect(result.session.phase).toBe('awaiting_confirmation');
    expectNoPurchase(runtime, result.session);
  });

  test('the fourth and last tool can quote successfully after two failed selections', async () => {
    const runtime = setup(), originalQuote = runtime.merchant.quote.bind(runtime.merchant);
    runtime.merchant.quote = async (...args) => {
      if (args[1].entry_id === 'coffee_alternative') throw new FlowError('out_of_stock', '刚刚售罄。');
      return originalQuote(...args);
    };
    const session = await created(runtime.coordinator);
    const { planner, contexts } = scripted([search, quote('coffee_with_fee'), quote('coffee_alternative'), quote('coffee_third')]);
    const result = await runToolLoop(runtime.coordinator, 'alice', session.id, planner, { maxSteps: 4 });
    expect(result.session.phase).toBe('awaiting_confirmation');
    expect(result.session.quote!.total_minor).toBe(800);
    expect(result.tool_calls).toBe(4);
    expect(contexts).toHaveLength(4);
    expectNoPurchase(runtime, result.session);
  });

  test('a user-specific preference can stop after failed quote without forced substitution', async () => {
    const runtime = setup(), session = await created(runtime.coordinator);
    const { planner, contexts } = scripted([search, quote('coffee_with_fee'), wait]);
    const result = await runToolLoop(runtime.coordinator, 'alice', session.id, planner);
    expect(result.session.phase).toBe('failed');
    expect(result.session.error!.code).toBe('budget_exceeded');
    expect(runtime.quotes).toEqual(['coffee_with_fee']);
    expect(contexts).toHaveLength(3);
    expectNoPurchase(runtime, result.session);
  });

  test.each(['unauthorized', 'authorization_invalid', 'protocol_error', 'network_error'])('%s quote failure stops rather than trying another item', async code => {
    const runtime = setup();
    runtime.merchant.quote = async () => { throw new FlowError(code, '不可恢复的服务错误。'); };
    const session = await created(runtime.coordinator);
    const { planner, contexts } = scripted([search, quote('coffee_with_fee')]);
    const result = await runToolLoop(runtime.coordinator, 'alice', session.id, planner);
    expect(result.session.error!.code).toBe(code);
    expect(result.session.phase).toBe('failed');
    expect(contexts).toHaveLength(2);
    expectNoPurchase(runtime, result.session);
  });

  test.each(['network_error', 'out_of_stock'])('%s search failure stops even if its code can be retried for quote', async code => {
    const runtime = setup();
    runtime.merchant.search = async () => { throw new FlowError(code, '目录搜索未成功。'); };
    const session = await created(runtime.coordinator);
    const { planner, contexts } = scripted([search]);
    const result = await runToolLoop(runtime.coordinator, 'alice', session.id, planner);
    expect(result.session.phase).toBe('failed');
    expect(result.session.error!.code).toBe(code);
    expect(contexts).toHaveLength(1);
    expectNoPurchase(runtime, result.session);
  });

  test('a repeated failed quote remains blocked instead of using recovery to bypass repetition', async () => {
    const runtime = setup(), session = await created(runtime.coordinator);
    const { planner } = scripted([search, quote('coffee_with_fee'), quote('coffee_with_fee')]);
    await expect(runToolLoop(runtime.coordinator, 'alice', session.id, planner)).rejects.toMatchObject({ code: 'repeated_tool' });
    expect(runtime.quotes).toEqual(['coffee_with_fee']);
    expectNoPurchase(runtime, await runtime.coordinator.get('alice', session.id));
  });

  test('recovery does not extend the tool budget when another candidate remains', async () => {
    const runtime = setup(), session = await created(runtime.coordinator);
    const { planner, contexts } = scripted([search, quote('coffee_with_fee')]);
    await expect(runToolLoop(runtime.coordinator, 'alice', session.id, planner, { maxSteps: 2 })).rejects.toMatchObject({ code: 'tool_limit' });
    expect(contexts).toHaveLength(2);
    expect(runtime.quotes).toEqual(['coffee_with_fee']);
    expectNoPurchase(runtime, await runtime.coordinator.get('alice', session.id));
  });

  test('exhausted candidate choices stop normally instead of another model request', async () => {
    const runtime = setup();
    runtime.merchant.search = async () => [structuredClone(candidates[0]!)];
    const session = await created(runtime.coordinator);
    const { planner, contexts } = scripted([search, quote('coffee_with_fee')]);
    const result = await runToolLoop(runtime.coordinator, 'alice', session.id, planner);
    expect(result.session.error!.code).toBe('budget_exceeded');
    expect(contexts).toHaveLength(2);
    expectNoPurchase(runtime, result.session);
  });

  test('an existing purchase attempt prevents all selection recovery, including definite failed purchases', async () => {
    for (const status of ['processing', 'failed', 'confirmed'] as const) {
      const runtime = setup(), session = await created(runtime.coordinator);
      const saved = (await runtime.store.read(session.id))!;
      saved.candidates = structuredClone(candidates); saved.phase = 'failed';
      saved.error = { code: 'budget_exceeded', message: '购买未成功。' };
      saved.attempt = { purchase_attempt_id: 'attempt_existing', idempotency_key: 'key_existing', status };
      await runtime.store.write(saved);
      const { planner, contexts } = scripted([]);
      const result = await runToolLoop(runtime.coordinator, 'alice', session.id, planner);
      expect(result.session.attempt!.purchase_attempt_id).toBe('attempt_existing');
      expect(contexts).toEqual([]);
      expect(runtime.diagnostics()).toEqual({ authorizations: 0, checkouts: 0, searches: 0 });
    }
  });

  test('another session becoming unresolved stops before asking the model for an alternative', async () => {
    const runtime = setup(), session = await created(runtime.coordinator), other = await created(runtime.coordinator);
    const originalQuote = runtime.merchant.quote.bind(runtime.merchant);
    runtime.merchant.quote = async (...args) => {
      const pending = (await runtime.store.read(other.id))!;
      pending.phase = 'unknown';
      pending.attempt = { purchase_attempt_id: 'attempt_other', idempotency_key: 'key_other', status: 'processing' };
      await runtime.store.write(pending);
      return originalQuote(...args);
    };
    const { planner, contexts } = scripted([search, quote('coffee_with_fee')]);
    await expect(runToolLoop(runtime.coordinator, 'alice', session.id, planner)).rejects.toMatchObject({ code: 'unresolved_purchase' });
    expect(contexts).toHaveLength(2);
    expectNoPurchase(runtime, await runtime.coordinator.get('alice', session.id));
  });

  test('cancellation during a failed selection stops before requesting an alternative', async () => {
    const runtime = setup(), controller = new AbortController();
    runtime.merchant.quote = async () => {
      controller.abort(new FlowError('agent_timeout', '整轮规划已超时。', 504));
      throw new FlowError('out_of_stock', '商品已售罄。');
    };
    const session = await created(runtime.coordinator);
    const { planner, contexts } = scripted([search, quote('coffee_with_fee')]);
    await expect(runToolLoop(runtime.coordinator, 'alice', session.id, planner, { signal: controller.signal })).rejects.toMatchObject({ code: 'agent_timeout' });
    await runtime.coordinator.waitForIdle();
    expect(contexts).toHaveLength(2);
    const saved = await runtime.coordinator.get('alice', session.id);
    expect(saved.phase).toBe('failed');
    expect(saved.quote).toBeUndefined();
    expectNoPurchase(runtime, saved);
  });

  function basketRuntime() {
    const runtime = setup();
    runtime.merchant.quoteBasket = async (userId, selections, requested) => {
      const items = selections.map(({ candidate, quantity }) => ({ entry_id: candidate.entry_id, title: candidate.title,
        quantity, unit_price_minor: candidate.search_price_minor, line_total_minor: candidate.search_price_minor * quantity }));
      const ids = items.map(item => item.entry_id);
      runtime.quotes.push(ids.join(','));
      const fee = ids.includes('coffee_with_fee') && ids.includes('coffee_alternative') ? 1000 : 100;
      const quoteId = `quote_${crypto.randomUUID()}`, total = items.reduce((sum, item) => sum + item.line_total_minor, 0) + fee;
      const terms = quoteTermsSchema.parse({ v: TERMS_DOMAIN, merchant_id: requested.merchant_id, quote_id: quoteId,
        currency: requested.currency, total_minor: total, items: items.map(item => ({ entry_id: item.entry_id,
          quantity: item.quantity, unit_minor: item.unit_price_minor })), fees: [{ code: 'service', amount_minor: fee }],
        fulfillment: { method: requested.fulfillment } });
      return { quote_id: quoteId, user_id: userId, merchant_id: requested.merchant_id,
        catalog_id: 'local_catalog', entry_id: items[0]!.entry_id, title: items[0]!.title, items,
        quantity: requested.quantity, fulfillment: requested.fulfillment, currency: requested.currency,
        unit_price_minor: items[0]!.unit_price_minor, fees: [{ label: '整单服务费', code: 'service', amount_minor: fee }],
        total_minor: total, wire_terms: terms,
        terms_hash: computeTermsHash(terms), expires_at: new Date(Date.now() + 60_000).toISOString() };
    };
    return runtime;
  }
  const basketIntent: Intent = { ...intent, query: '咖啡 / 咖啡', quantity: 2, max_total_minor: 2500,
    items: [{ query: '咖啡', quantity: 1 }, { query: '咖啡', quantity: 1 }] };

  test('a failed basket may reuse one selected product in a different affordable combination', async () => {
    const runtime = basketRuntime(), session = await runtime.coordinator.create('alice', basketIntent);
    const { planner, contexts } = scripted([search, basketQuote(['coffee_with_fee', 'coffee_alternative']),
      basketQuote(['coffee_with_fee', 'coffee_third'])]);
    const result = await runToolLoop(runtime.coordinator, 'alice', session.id, planner, { maxSteps: 3 });
    expect(contexts[2]!.history[1]!.error!.code).toBe('budget_exceeded');
    expect(result.session.phase).toBe('awaiting_confirmation'); expect(result.session.quote!.total_minor).toBe(1700);
    expect(runtime.quotes).toEqual(['coffee_with_fee,coffee_alternative', 'coffee_with_fee,coffee_third']);
    expectNoPurchase(runtime, result.session);
  });
  test('reordering an identical basket cannot bypass repetition limits', async () => {
    const runtime = basketRuntime(), session = await runtime.coordinator.create('alice', basketIntent);
    const { planner } = scripted([search, basketQuote(['coffee_with_fee', 'coffee_alternative']),
      basketQuote(['coffee_alternative', 'coffee_with_fee'])]);
    await expect(runToolLoop(runtime.coordinator, 'alice', session.id, planner)).rejects.toMatchObject({ code: 'repeated_tool' });
    expect(runtime.quotes).toEqual(['coffee_with_fee,coffee_alternative']);
    expectNoPurchase(runtime, await runtime.coordinator.get('alice', session.id));
  });
  test('basket fingerprints retain actual per-product quantities and merge duplicate products', async () => {
    const runtime = basketRuntime(), created = await runtime.coordinator.create('alice', { ...basketIntent,
      quantity: 3, max_total_minor: 4000, items: [{ query: '咖啡', quantity: 1 }, { query: '咖啡', quantity: 2 }] });
    const session = await runtime.coordinator.search('alice', created.id);
    const original = quoteFingerprint(session, ['coffee_with_fee', 'coffee_alternative']);
    const swapped = quoteFingerprint(session, ['coffee_alternative', 'coffee_with_fee']);
    expect(original).not.toBe(swapped);
    expect(JSON.parse(quoteFingerprint(session, ['coffee_with_fee', 'coffee_with_fee'])).items)
      .toEqual([{ entry_id: 'coffee_with_fee', quantity: 3 }]);
    expect(hasUntriedQuote(session, new Set([original]))).toBe(true);
  });
  test('one empty basket group stops without taking a partial quote', async () => {
    const runtime = basketRuntime();
    runtime.merchant.search = async requested => requested.query === '缺货' ? [] : structuredClone(candidates);
    const session = await runtime.coordinator.create('alice', { ...basketIntent,
      items: [{ query: '咖啡', quantity: 1 }, { query: '缺货', quantity: 1 }] });
    const { planner, contexts } = scripted([search]);
    const result = await runToolLoop(runtime.coordinator, 'alice', session.id, planner, { maxSteps: 1 });
    expect(result.session.phase).toBe('candidates'); expect(result.session.candidates.length).toBeGreaterThan(0);
    expect(result.session.quote).toBeUndefined(); expect(runtime.quotes).toEqual([]); expect(contexts).toHaveLength(1);
    expectNoPurchase(runtime, result.session);
  });
  test('an unresolved purchase in another session blocks a basket alternative before another planner call', async () => {
    const runtime = basketRuntime(), session = await runtime.coordinator.create('alice', basketIntent);
    const other = await runtime.coordinator.create('alice', basketIntent), original = runtime.merchant.quoteBasket!;
    runtime.merchant.quoteBasket = async (...args) => {
      const saved = (await runtime.store.read(other.id))!;
      saved.phase = 'unknown'; saved.attempt = { purchase_attempt_id: 'attempt_mixed_unknown', idempotency_key: 'key_mixed_unknown', status: 'processing' };
      await runtime.store.write(saved);
      return original(...args);
    };
    const { planner, contexts } = scripted([search, basketQuote(['coffee_with_fee', 'coffee_alternative'])]);
    await expect(runToolLoop(runtime.coordinator, 'alice', session.id, planner)).rejects.toMatchObject({ code: 'unresolved_purchase' });
    expect(contexts).toHaveLength(2); expectNoPurchase(runtime, await runtime.coordinator.get('alice', session.id));
  });
});
