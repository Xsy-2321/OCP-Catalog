import { describe, expect, test } from 'bun:test';
// Exercise the exact generated entry imported by the two browser pages.
import { parseMerchantOrderDetail, parseMerchantOrdersPage, parseMerchantProductsPage } from '../public/contracts.js';

const product = { entry_id: 'latte', title: 'Latte', price_minor: 2600, currency: 'CNY',
  inventory: { availability_status: 'in_stock', available_quantity: 4, reserved_quantity: 1 },
  fulfillment: { methods: ['pickup', 'delivery'], delivery_fee_minor: 500 } };
const date = '2026-10-08T00:00:00.000Z';
const order = { order_id: 'order_fixture', merchant_id: 'coffee', catalog_id: 'coffee', purchase_attempt_id: 'attempt_fixture',
  quote_id: 'quote_fixture', currency: 'CNY', terms_hash: 'a'.repeat(64),
  items: [{ entry_id: 'latte', title: 'Latte', quantity: 2, unit_minor: 2600, line_total_minor: 5200 }],
  fees: [{ code: 'delivery', label: 'Delivery', amount_minor: 500 }], subtotal_minor: 5200, total_minor: 5700,
  fulfillment: { method: 'delivery', delivery: { recipient: '测试收件人', phone: '13800000000', address: '测试大学一号楼101室' } },
  payment: { status: 'paid', updated_at: date }, fulfillment_status: { status: 'ready', updated_at: date }, created_at: date, updated_at: date };

describe('browser responses preserve merchant validation and privacy', () => {
  test.each([
    { items: [product], total: 0, has_more: false, next_cursor: null },
    { items: [product], total: 2, has_more: true, next_cursor: null },
    { items: [], total: 2, has_more: true, next_cursor: 'next' },
    { items: [product], total: 2, has_more: true, next_cursor: '' },
    { items: [product], total: 2, has_more: true, next_cursor: 'x'.repeat(2049) },
  ])('rejects inconsistent page metadata %#', (page) => {
    expect(() => parseMerchantProductsPage(page)).toThrow();
  });

  test('recipient details are accepted only in a detail response', () => {
    expect(parseMerchantOrderDetail(order).fulfillment.delivery?.address).toBe('测试大学一号楼101室');
    expect(() => parseMerchantOrdersPage({ items: [order], total: 1, has_more: false, next_cursor: null })).toThrow();
    const summary = { ...order, fulfillment: { method: 'delivery' } };
    expect(parseMerchantOrdersPage({ items: [summary], total: 1, has_more: false, next_cursor: null }).items).toHaveLength(1);
  });

  test('line arithmetic, subtotal, fees and duplicate entries remain checked in the browser bundle', () => {
    expect(() => parseMerchantOrderDetail({ ...order, items: [{ ...order.items[0], line_total_minor: 5199 }] })).toThrow();
    expect(() => parseMerchantOrderDetail({ ...order, subtotal_minor: 5199 })).toThrow();
    expect(() => parseMerchantOrderDetail({ ...order, total_minor: 5699 })).toThrow();
    expect(() => parseMerchantOrderDetail({ ...order, items: [...order.items, ...order.items], subtotal_minor: 10400, total_minor: 10900 })).toThrow();
    expect(() => parseMerchantOrderDetail({ ...order, currency: 'cny' })).toThrow();
  });
});
