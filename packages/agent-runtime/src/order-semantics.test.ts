import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { Order as WireOrder } from '@ocp-catalog/shopping-contracts';
import { HttpMerchantTransport } from './http-transport';

const fixture: { cases: { name: string; valid: boolean; order: WireOrder }[] } = JSON.parse(
  readFileSync(new URL('../../../fixtures/shopping/order-conformance.json', import.meta.url), 'utf8'),
);

describe('consumer order reads share the merchant order snapshot matrix', () => {
  for (const example of fixture.cases) {
    test(example.name, async () => {
      const requests: { url: string; init: RequestInit | undefined }[] = [];
      const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ url: String(input), init });
        return Response.json(example.order);
      }) as typeof globalThis.fetch;
      const transport = new HttpMerchantTransport({ origin: 'http://127.0.0.1:8787',
        merchantId: 'merchant_coffee_demo', catalogId: 'catalog_coffee_demo', fetch: fetcher });
      if (example.valid) {
        const order = await transport.getOrder('user_semantic_matrix', example.order.order_id);
        expect(order.order_id).toBe(example.order.order_id);
        expect(order.currency).toBe(example.order.currency);
        expect(order.total_minor).toBe(example.order.total_minor);
        expect(order.quantity).toBe(example.order.items.reduce((sum, item) => sum + item.quantity, 0));
        expect(order.items).toEqual(example.order.items.map(item => ({
          entry_id: item.entry_id, title: item.title, quantity: item.quantity,
          unit_price_minor: item.unit_minor, line_total_minor: item.line_total_minor,
        })));
      } else {
        await expect(transport.getOrder('user_semantic_matrix', example.order.order_id))
          .rejects.toMatchObject({ code: 'protocol_error' });
      }
      expect(requests).toHaveLength(1);
      expect(requests[0]!.url).toBe('http://127.0.0.1:8787/commerce/v1/orders/ord_semantic_matrix');
      expect(requests[0]!.init).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit' });
      expect(new Headers(requests[0]!.init?.headers).get('x-dev-caller-id')).toBe('user_semantic_matrix');
    });
  }
});
