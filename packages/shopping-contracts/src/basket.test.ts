import { describe, expect, test } from 'bun:test';
import { computeTermsHash, createQuoteRequestSchema, deliveryAddressSchema, quoteFulfillmentSchema,
  quoteRequestItems, quoteTermsSchema, TERMS_DOMAIN } from './index';
const delivery = { recipient: '验收收件人', phone: '13800000000', address: '测试大学一号楼101室' };
const items = [{ entry_id: 'latte', quantity: 1 }, { entry_id: 'americano', quantity: 2 }];
describe('whole basket and delivery application contract', () => {
  test('new basket requests retain all line quantities and legacy pickup stays unchanged', () => {
    const legacy = { entry_id: 'latte', quantity: 2, fulfillment: { method: 'pickup' } };
    expect(createQuoteRequestSchema.parse(legacy)).toEqual(legacy);
    expect(quoteRequestItems(createQuoteRequestSchema.parse(legacy))).toEqual([{ entry_id: 'latte', quantity: 2 }]);
    const basket = { items, fulfillment: { method: 'delivery', delivery } };
    expect(createQuoteRequestSchema.parse(basket)).toEqual(basket);
    expect(quoteRequestItems(createQuoteRequestSchema.parse(basket))).toEqual(items);
  });
  test('rejects duplicate lines, unsafe totals, extra prices and conflicting request shapes', () => {
    for (const request of [
      { items: [items[0], items[0]], fulfillment: { method: 'pickup' } },
      { items: [{ entry_id: 'latte', quantity: 20 }, { entry_id: 'americano', quantity: 1 }], fulfillment: { method: 'pickup' } },
      { items: [{ entry_id: 'latte', quantity: Number.MAX_SAFE_INTEGER + 1 }], fulfillment: { method: 'pickup' } },
      { items: [{ entry_id: 'latte', quantity: 1, unit_minor: 0 }], fulfillment: { method: 'pickup' } },
      { entry_id: 'latte', quantity: 1, items, fulfillment: { method: 'pickup' } },
      { items: [], fulfillment: { method: 'pickup' } },
    ]) expect(createQuoteRequestSchema.safeParse(request).success).toBe(false);
  });
  test('new delivery requires valid customer details while old saved delivery records remain readable', () => {
    expect(createQuoteRequestSchema.safeParse({ items, fulfillment: { method: 'delivery' } }).success).toBe(false);
    expect(quoteFulfillmentSchema.parse({ method: 'delivery' })).toEqual({ method: 'delivery' });
    expect(createQuoteRequestSchema.safeParse({ items, fulfillment: { method: 'pickup', delivery } }).success).toBe(false);
    expect(deliveryAddressSchema.parse({ ...delivery, recipient: ' 验收收件人 ', phone: '+86 138-0000-0000' })).toEqual({
      ...delivery, phone: '+8613800000000' });
    for (const value of [{ ...delivery, recipient: '' }, { ...delivery, phone: 'call-me' }, { ...delivery, address: '宿舍' },
      { ...delivery, country: 'invented' }]) expect(deliveryAddressSchema.safeParse(value).success).toBe(false);
  });
  test('the full delivery address and every product quantity are bound into the terms hash', () => {
    const terms = quoteTermsSchema.parse({ v: TERMS_DOMAIN, merchant_id: 'merchant', quote_id: 'quote', currency: 'CNY',
      total_minor: 4980, items: [{ entry_id: 'latte', quantity: 1, unit_minor: 2500 },
        { entry_id: 'americano', quantity: 2, unit_minor: 990 }], fees: [{ code: 'delivery', amount_minor: 500 }],
      fulfillment: { method: 'delivery', delivery } });
    const original = computeTermsHash(terms);
    expect(computeTermsHash({ ...terms, items: [...terms.items].reverse() })).toBe(original);
    for (const field of ['recipient', 'phone', 'address'] as const) {
      const changed = structuredClone(terms); changed.fulfillment.delivery![field] += 'changed';
      expect(computeTermsHash(changed)).not.toBe(original);
    }
    const changed = structuredClone(terms); changed.items[1]!.quantity += 1;
    expect(computeTermsHash(changed)).not.toBe(original);
  });
});
