import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeTermsHash } from '@ocp-catalog/shopping-contracts';
import { parseSessionView, isPendingPurchase, shouldStopPlanning } from '@ocp-catalog/shopping-contracts/browser';
import { normalizeStoredSession, normalizeQuote } from './basket-model';
import { toSessionView } from './session-view';
import { LocalMockIssuer } from './authorization';
import { MockMerchantTransport, MOCK_ORIGIN } from './mock-transport';
import { FileSessionStore } from './store';
import { ShoppingCoordinator } from './coordinator';
import { parseIntent } from './validation';
import type { Candidate, MerchantPort, Session } from './types';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const timestamp = '2026-10-08T00:00:00.000Z';
const candidate: Candidate = { entry_id: 'coffee', catalog_id: 'catalog', merchant_id: 'coffee-demo',
  title: '咖啡', description: '', search_price_minor: 100, currency: 'CNY', in_stock: true };
function session(): Session {
  return { id: `session_${crypto.randomUUID()}`, user_id: 'buyer-secret', mode: 'mock', phase: 'candidates',
    intent: parseIntent({ query: '咖啡', quantity: 1, currency: 'CNY', max_total_minor: 3000,
      merchant_id: 'coffee-demo', fulfillment: 'pickup' }), candidates: [candidate],
    revision: 0, created_at: timestamp, updated_at: timestamp };
}
test('page projection allowlists both top-level and nested runtime fields', () => {
  const record = session();
  Object.assign(record, { internal_private_key: 'must-stay-private', checkout_url: 'https://secret.invalid',
    selection: [{ candidate: { ...candidate, internal_token: 'must-stay-private' }, quantity: 1 }] });
  Object.assign(record.intent, { internal_budget_note: 'must-stay-private' });
  Object.assign(record.candidates[0]!, { provider_key: 'must-stay-private' });
  record.quote = normalizeQuote({ quote_id: 'quote', user_id: record.user_id, merchant_id: 'coffee-demo',
    entry_id: 'coffee', title: '咖啡', quantity: 1, fulfillment: 'pickup', currency: 'CNY',
    unit_price_minor: 100, total_minor: 100, fees: [], terms_hash: 'legacy-hash', expires_at: timestamp });
  Object.assign(record.quote.items[0]!, { internal_payment_ref: 'must-stay-private' });
  Object.assign(record.quote, { issuer_secret: 'must-stay-private' });
  record.order = { order_id: 'order', purchase_attempt_id: 'attempt', title: '咖啡', quantity: 1,
    currency: 'CNY', total_minor: 100, payment_status: 'paid', fulfillment_status: 'preparing', updated_at: timestamp };
  Object.assign(record.order, { payment_reference: 'must-stay-private' });
  const view = toSessionView(record);
  expect(JSON.stringify(view)).not.toContain('must-stay-private');
  expect(JSON.stringify(view)).not.toContain('buyer-secret');
  expect(view).not.toHaveProperty('checkout_url');
  expect(view.selected?.entry_id).toBe('coffee');
  view.candidates[0]!.title = 'edited view';
  expect(record.candidates[0]!.title).toBe('咖啡');
});
test('legacy single-item decoding preserves purchase evidence and never changes terms_hash', () => {
  const record = session();
  const legacy = { ...record, intent: { query: '咖啡', quantity: 1, currency: 'CNY', max_total_minor: 3000,
    merchant_id: 'coffee-demo', fulfillment: 'pickup' }, selected: candidate } as unknown as Session;
  const normalized = normalizeStoredSession(legacy);
  expect(normalized.intent.items).toEqual([{ query: '咖啡', quantity: 1 }]);
  expect(normalized.selection).toEqual([{ candidate, quantity: 1 }]);
  expect(normalized).not.toHaveProperty('selected');
  expect(toSessionView(normalized).selected?.entry_id).toBe(candidate.entry_id);
});
test('a legacy single-item merchant port still completes exactly one confirmed purchase', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ocp-legacy-port-'));
  directories.push(directory);
  const issuer = new LocalMockIssuer();
  const base = new MockMerchantTransport(join(directory, 'merchant'), issuer.publicKey);
  const port: MerchantPort = {
    mode: 'mock', search: base.search.bind(base), resolve: base.resolve.bind(base),
    async quote(...args) { const { items: _lines, ...legacy } = await base.quote(...args); return legacy; },
    checkout: base.checkout.bind(base), getAttempt: base.getAttempt.bind(base),
    async getOrder(...args) { const { items: _lines, ...legacy } = await base.getOrder(...args); return legacy; },
  };
  const coordinator = new ShoppingCoordinator(port, new FileSessionStore(join(directory, 'sessions')), issuer, MOCK_ORIGIN);
  const created = await coordinator.create('buyer', { query: '拿铁', quantity: 1, currency: 'CNY',
    max_total_minor: 3000, merchant_id: 'coffee-demo', fulfillment: 'pickup' });
  await coordinator.search('buyer', created.id);
  const quoted = await coordinator.select('buyer', created.id, 'mock_latte');
  expect(quoted.quote!.items).toHaveLength(1);
  const signedHash = computeTermsHash(quoted.quote!.wire_terms!);
  expect(signedHash).toBe(quoted.quote!.terms_hash);
  const confirmation = { quote_id: quoted.quote!.quote_id, terms_hash: signedHash, revision: quoted.revision };
  const bought = await coordinator.confirm('buyer', created.id, confirmation);
  expect(bought.phase).toBe('confirmed');
  expect(bought.order!.items).toHaveLength(1);
  expect((await coordinator.confirm('buyer', created.id, confirmation)).order!.order_id).toBe(bought.order!.order_id);
  expect(base.checkoutCalls).toBe(1);
});
test('confirmed purchase evidence with an unavailable order remains a valid locked view', () => {
  const record = session();
  record.phase = 'unknown';
  record.attempt = { purchase_attempt_id: 'original', idempotency_key: 'never-expose', status: 'confirmed', order_id: 'order' };
  const view = parseSessionView(toSessionView(record));
  expect(isPendingPurchase(view)).toBe(true);
  expect(shouldStopPlanning(view)).toBe(true);
  expect(view.order).toBeUndefined();
  expect(JSON.stringify(view)).not.toContain('never-expose');
});
test('signed terms reject unknown nested fields instead of accepting an altered signed shape', () => {
  const record = session();
  record.quote = normalizeQuote({ quote_id: 'quote', user_id: 'buyer', merchant_id: 'coffee-demo',
    entry_id: 'coffee', title: '咖啡', quantity: 1, fulfillment: 'pickup', currency: 'CNY',
    unit_price_minor: 100, total_minor: 100, fees: [], terms_hash: 'hash', expires_at: timestamp });
  Object.assign(record.quote, { wire_terms: { v: 'ocp.demo.terms.v1', merchant_id: 'coffee-demo', quote_id: 'quote',
    currency: 'CNY', total_minor: 100, items: [{ entry_id: 'coffee', quantity: 1, unit_minor: 100 }], fees: [],
    fulfillment: { method: 'pickup' }, internal_secret: 'must-stay-private' } });
  expect(() => toSessionView(record)).toThrow();
});
