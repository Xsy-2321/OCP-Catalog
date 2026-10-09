import { describe, expect, test } from 'bun:test';
import { parseSessionView } from '../../../packages/shopping-contracts/src/browser';
import { createPageState, draftFromSession, draftQuantity } from '../public/view-model.js';

function session(intent: Record<string, unknown> = {}) {
  return parseSessionView({ id: 'session_restore', mode: 'mock', phase: 'candidates',
    intent: { query: '拿铁', quantity: 2, currency: 'CNY', max_total_minor: 5201,
      merchant_id: 'coffee', fulfillment: 'pickup', ...intent }, candidates: [], revision: 1,
    created_at: '2026-10-08T00:00:00.000Z', updated_at: '2026-10-08T00:00:00.000Z' });
}

describe('pure draft restoration', () => {
  test('legacy single request restores exact amounts without requiring normalized items', () => {
    const draft = draftFromSession(session());
    expect(draft).toEqual({ mode: 'manual', message: '', query: '拿铁', quantity: 2,
      budget: '52.01', mixed: false, items: [], fulfillment: 'pickup',
      delivery: { recipient: '', phone: '', address: '' }, changed: false });
    expect(draftQuantity(draft)).toBe(2);
  });

  test('normalized single request retains the single input rather than a hidden basket', () => {
    const draft = draftFromSession(session({ items: [{ query: '拿铁', quantity: 2 }] }));
    expect(draft.mixed).toBe(false);
    expect(draft.items).toEqual([]);
    expect(draft.quantity).toBe(2);
  });

  test('mixed request replaces the previous basket and resets dirty state', () => {
    const previous = createPageState().draft;
    previous.items = [{ query: '旧需求', quantity: 20 }];
    previous.changed = true;
    const draft = draftFromSession(session({ query: '拿铁、浓缩', quantity: 5,
      items: [{ query: '拿铁', quantity: 2 }, { query: '浓缩', quantity: 3 }] }), previous);
    expect(draft.mixed).toBe(true);
    expect(draft.items).toEqual([{ query: '拿铁', quantity: 2 }, { query: '浓缩', quantity: 3 }]);
    expect(draftQuantity(draft)).toBe(5);
    expect(draft.changed).toBe(false);
    expect(previous.items).toEqual([{ query: '旧需求', quantity: 20 }]);
    expect(previous.changed).toBe(true);
  });

  test('restoring an agent result retains its selected mode and original message', () => {
    const draft = draftFromSession(session(), { mode: 'agent', message: '请推荐两杯拿铁' });
    expect(draft.mode).toBe('agent');
    expect(draft.message).toBe('请推荐两杯拿铁');
    expect(draft.changed).toBe(false);
  });

  test('delivery and basket values are detached from the validated server snapshot', () => {
    const restored = session({ query: '拿铁、浓缩', quantity: 5, fulfillment: 'delivery',
      delivery: { recipient: '测试收件人', phone: '13800000000', address: '测试路一号' },
      items: [{ query: '拿铁', quantity: 2 }, { query: '浓缩', quantity: 3 }] });
    const before = JSON.stringify(restored);
    const draft = draftFromSession(restored);
    expect(draft.fulfillment).toBe('delivery');
    expect(draft.delivery).toEqual(restored.intent.delivery!);
    expect(draft.items).not.toBe(restored.intent.items);
    expect(draft.items[0]).not.toBe(restored.intent.items![0]);
    expect(draft.delivery).not.toBe(restored.intent.delivery);
    draft.items[0].query = '已编辑';
    draft.items[1].quantity = 1;
    draft.delivery.recipient = '已编辑';
    expect(JSON.stringify(restored)).toBe(before);
  });

  test('pickup restoration clears stale delivery details from the previous draft', () => {
    const previous = createPageState().draft;
    previous.fulfillment = 'delivery';
    previous.delivery = { recipient: '旧收件人', phone: '13800000000', address: '旧地址一号' };
    const draft = draftFromSession(session(), previous);
    expect(draft.fulfillment).toBe('pickup');
    expect(draft.delivery).toEqual({ recipient: '', phone: '', address: '' });
    expect(previous.delivery.recipient).toBe('旧收件人');
  });
});
