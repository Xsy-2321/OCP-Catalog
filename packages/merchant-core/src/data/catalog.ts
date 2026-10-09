/**
 * The demo coffee catalog.
 *
 * This is the merchant's own stock list, held in code rather than loaded from a
 * file at runtime, so that starting the server cannot fail because of a
 * relative path. It is the same data as `fixtures/shopping/catalog.coffee.json`
 * — that fixture is what A develops against before this server exists — and
 * `catalog-data.test.ts` asserts the two are still identical, so the copy
 * cannot rot silently.
 *
 * The five entries are chosen to cover the four cases a caller must handle,
 * not to look like a menu: one affordable item, one cheapest item for
 * comparison, one over budget, one out of stock, and one with a single unit
 * left so the concurrency boundary is reachable.
 */
import type { CatalogEntry } from '@ocp-catalog/ocp-schema';

export const CATALOG_SEED: readonly CatalogEntry[] = [
  {
    kind: 'CatalogEntry',
    catalog_id: 'catalog_coffee_demo',
    entry_id: 'entry_latte',
    provider_id: 'provider_coffee_demo',
    object_id: 'obj_entry_latte',
    object_type: 'ocp.commerce.product',
    title: '拿铁',
    summary: '标准杯拿铁，中深烘拼配豆。',
    attributes: {
      brand: '演示咖啡',
      category: 'coffee',
      // The existing OCP price pack keeps decimal major units — unchanged.
      price: { currency: 'CNY', amount: 25, price_type: 'fixed' },
      // The same price in integer minor units, for the commerce flow.
      price_minor: 2500,
      inventory: { availability_status: 'in_stock', quantity: 12 },
      fulfillment: { methods: ['pickup', 'delivery'], delivery_fee_minor: 500 },
    },
  },
  {
    kind: 'CatalogEntry',
    catalog_id: 'catalog_coffee_demo',
    entry_id: 'entry_americano',
    provider_id: 'provider_coffee_demo',
    object_id: 'obj_entry_americano',
    object_type: 'ocp.commerce.product',
    title: '美式',
    summary: '标准杯美式，热饮。',
    attributes: {
      brand: '演示咖啡',
      category: 'coffee',
      price: { currency: 'CNY', amount: 9.9, price_type: 'fixed' },
      price_minor: 990,
      inventory: { availability_status: 'in_stock', quantity: 30 },
      fulfillment: { methods: ['pickup', 'delivery'], delivery_fee_minor: 500 },
    },
  },
  {
    kind: 'CatalogEntry',
    catalog_id: 'catalog_coffee_demo',
    entry_id: 'entry_gift_box',
    provider_id: 'provider_coffee_demo',
    object_id: 'obj_entry_gift_box',
    object_type: 'ocp.commerce.product',
    title: '手冲礼盒',
    summary: '含滤杯、滤纸与两包单品豆。',
    attributes: {
      brand: '演示咖啡',
      category: 'merchandise',
      price: { currency: 'CNY', amount: 88, price_type: 'fixed' },
      price_minor: 8800,
      inventory: { availability_status: 'in_stock', quantity: 5 },
      fulfillment: { methods: ['pickup'] },
    },
  },
  {
    kind: 'CatalogEntry',
    catalog_id: 'catalog_coffee_demo',
    entry_id: 'entry_soldout',
    provider_id: 'provider_coffee_demo',
    object_id: 'obj_entry_soldout',
    object_type: 'ocp.commerce.product',
    title: '脏脏咖啡',
    summary: '季节性特调，今日已售完。',
    attributes: {
      brand: '演示咖啡',
      category: 'coffee',
      price: { currency: 'CNY', amount: 28, price_type: 'fixed' },
      price_minor: 2800,
      inventory: { availability_status: 'out_of_stock', quantity: 0 },
      fulfillment: { methods: ['pickup'] },
    },
  },
  {
    kind: 'CatalogEntry',
    catalog_id: 'catalog_coffee_demo',
    entry_id: 'entry_cold_brew',
    provider_id: 'provider_coffee_demo',
    object_id: 'obj_entry_cold_brew',
    object_type: 'ocp.commerce.product',
    title: '冷萃',
    summary: '十二小时冷萃，仅剩最后一杯。',
    attributes: {
      brand: '演示咖啡',
      category: 'coffee',
      price: { currency: 'CNY', amount: 30, price_type: 'fixed' },
      price_minor: 3000,
      inventory: { availability_status: 'low_stock', quantity: 1 },
      fulfillment: { methods: ['pickup'] },
    },
  },
];
