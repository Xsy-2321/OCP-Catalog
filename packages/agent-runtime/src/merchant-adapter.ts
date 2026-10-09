import type { BasketSelection, Intent, MerchantPort, Order, Quote, ReadOperationOptions } from './types';
import { normalizeQuote } from './basket-model';
import { FlowError } from './errors';

/** The only compatibility branch for older single-item merchant ports. */
export async function requestBasketQuote(merchant: MerchantPort, userId: string, selections: BasketSelection[],
  intent: Intent, options: ReadOperationOptions): Promise<Quote> {
  if (merchant.quoteBasket) return normalizeQuote(await merchant.quoteBasket(userId, selections, intent, options));
  if (selections.length !== 1 || intent.fulfillment !== 'pickup') {
    throw new FlowError('unsupported_capability', '当前商家适配器不支持整单或配送报价。');
  }
  const selection = selections[0]!;
  return normalizeQuote(await merchant.quote(userId, selection.candidate, intent, options));
}
export async function requestOrder(merchant: MerchantPort, userId: string, id: string, quote: Quote): Promise<Order> {
  const order = await merchant.getOrder(userId, id);
  if (order.items || merchant.quoteBasket || quote.items.length !== 1) return order;
  // Older single-item ports expose aggregates only. Preserve every original
  // aggregate for binding checks; synthesize display lines solely at this edge.
  return { ...order, items: [{ entry_id: quote.items[0]!.entry_id, title: order.title,
    quantity: order.quantity, unit_price_minor: quote.unit_price_minor,
    line_total_minor: quote.unit_price_minor * order.quantity }] };
}
