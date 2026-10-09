import type { CatalogEntryRecord } from './catalog';
import { isPurchasable } from './catalog';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}

/** The read-only destination of Resolve's advertised view action. */
export function productPage(record: CatalogEntryRecord): Response {
  const { entry, attributes } = record;
  const title = escapeHtml(entry.title);
  const unavailableLabels: Record<string, string> = {
    out_of_stock: '已售罄', preorder: '预售商品 · 暂不接受购买', unknown: '库存待确认 · 暂不接受购买',
  };
  const stock = isPurchasable(record)
    ? `可购买${attributes.inventory.quantity === undefined ? '' : ` · 剩余 ${attributes.inventory.quantity} 件`}`
    : unavailableLabels[attributes.inventory.availability_status] ?? '暂不可购买';
  const price = `${escapeHtml(attributes.price.currency)} ${(attributes.price_minor / 100).toFixed(2)}`;
  const deliveryFee = attributes.fulfillment.delivery_fee_minor;
  return new Response(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · 演示咖啡</title><style>
body{margin:0;background:#f6f3ec;color:#252d28;font:17px/1.7 system-ui,sans-serif}main{max-width:640px;margin:8vh auto;padding:32px}article{padding:32px;background:#fff;border:1px solid #deded3;border-radius:18px}h1{font-size:36px;line-height:1.2}strong{font-size:26px}p{margin:16px 0}.note{color:#58655e;font-size:14px}
</style></head><body><main><p>演示咖啡 · 商品详情</p><article><h1>${title}</h1>
<p>${escapeHtml(entry.summary ?? '')}</p><p><strong>${price}</strong> / 件</p><p>${stock}</p>
<p>履约方式：${attributes.fulfillment.methods.map(method => method === 'pickup' ? '到店自提' : '配送').join('、')}${attributes.fulfillment.methods.includes('delivery') && deliveryFee !== undefined ? `（配送费 ${(deliveryFee / 100).toFixed(2)} ${escapeHtml(attributes.price.currency)}）` : ''}</p>
<p class="note">通过购物助手获取最终报价并确认购买。报价包含适用费用，库存以结账时为准。</p></article>
<p class="note">这是本地演示，付款为模拟，不会产生真实扣款。</p></main></body></html>`, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff',
    },
  });
}
