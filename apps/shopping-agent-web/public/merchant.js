import { parseMerchantOverviewView, parseMerchantProductsPage, parseMerchantOrdersPage, parseMerchantOrderDetail } from './contracts.js';
import { getElement as $, getControl, getDialog, node } from './dom.js';
import { errorMessage, request } from './api-client.js';

  const endpoint = '/api/merchant-demo';
  let snapshotVersion = 0, detailVersion = 0, overviewBusy = false;
  /** @type {import('./contracts.js').MerchantProductsPage | null} */
  let products = null;
  /** @type {import('./contracts.js').MerchantOrdersPage | null} */
  let orders = null;
  let productsBusy = false;
  let ordersBusy = false;
  const unavailable = () => new Error('商家数据格式无效，当前不可用。请刷新或检查本机服务。');
  /** @param {number} minor @param {string} unit */
  const money = (minor, unit) => `${unit === 'CNY' ? '¥' : `${unit} `}${(minor / 100).toFixed(2)}`;
  /** @param {string} value */
  const time = value => new Date(value).toLocaleString('zh-CN', { hour12: false });
  /** @param {import('./contracts.js').MerchantOrderSummary['payment']['status']} status */
  const paymentLabel = status => ({ paid: '模拟已付款', pending: '模拟付款处理中', failed: '模拟付款失败', unknown: '模拟付款结果未知' })[status];
  /** @param {import('./contracts.js').MerchantOrderSummary['fulfillment_status']['status']} status @param {'pickup' | 'delivery'} fulfillment */
  const fulfillmentLabel = (status, fulfillment) => ({ pending: '待履约（模拟）', ready: fulfillment === 'delivery' ? '待配送（模拟）' : '待取餐（模拟）', completed: fulfillment === 'delivery' ? '模拟已送达' : '模拟已取餐', cancelled: '模拟已取消' })[status];
  /** @param {'pickup' | 'delivery'} value */
  const methodLabel = value => value === 'delivery' ? '配送（模拟）' : '到店自取';
  function notice(message = '') { $('merchant-notice').textContent = message; $('merchant-notice').hidden = !message; }
  /** @template T @param {string} path @param {(value: unknown) => T} parse @returns {Promise<T>} */
  async function read(path, parse) {
    try {
      return await request(path, (value) => {
        try { return parse(value); } catch { throw unavailable(); }
      }, undefined, 15_000);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw new Error('读取商家数据超时，请检查本机服务后重试。');
      if (error instanceof TypeError) throw new Error('无法连接本机商家数据服务，请检查服务后重试。');
      // Service diagnostics can contain internal identifiers; show a local explanation.
      throw unavailable();
    }
  }
  /** @param {string} textValue @param {string} [kind] */
  function status(textValue, kind = '') { return node('span', textValue, `status-pill${kind ? ` ${kind}` : ''}`); }
  function renderProducts() {
    $('products-list').replaceChildren();
    $('products-table-wrap').hidden = !products?.items.length;
    $('products-state').hidden = Boolean(products?.items.length);
    $('products-state').textContent = overviewBusy ? '正在读取商品…' : products ? '暂无商品。' : '商品数据当前不可用。';
    if (products) for (const product of products.items) {
      const row = node('tr'); row.dataset.entryId = product.entry_id;
      const name = node('td'); name.append(node('strong', product.title));
      /** @type {Record<string, string>} */
      const stockNames = { in_stock: '有货', low_stock: '库存较少', out_of_stock: '暂无库存', unknown: '库存未知', preorder: '预售' };
      const stock = node('td'); stock.append(status(stockNames[product.inventory.availability_status] || `状态：${product.inventory.availability_status}`,
        ['out_of_stock', 'unknown', 'preorder'].includes(product.inventory.availability_status) ? 'warning' : ''));
      const fulfillment = node('td');
      fulfillment.append(node('span', product.fulfillment.methods.length ? product.fulfillment.methods.map(methodLabel).join(' / ') : '暂无履约方式'));
      if (product.fulfillment.methods.includes('delivery')) fulfillment.append(node('small', product.fulfillment.delivery_fee_minor === null
        ? '配送费未单独声明，查看最终报价' : `配送费 ${money(product.fulfillment.delivery_fee_minor, product.currency)}`));
      row.append(name, node('td', money(product.price_minor, product.currency)), stock,
        node('td', product.inventory.available_quantity === null ? '未提供数量' : String(product.inventory.available_quantity)),
        node('td', String(product.inventory.reserved_quantity)), fulfillment);
      $('products-list').append(row);
    }
    $('product-total').textContent = products ? String(products.total) : '—';
    $('products-count').textContent = products ? `已显示 ${products.items.length} / ${products.total} 个商品` : '';
    getControl('products-more').hidden = !products?.has_more;
    getControl('products-more').disabled = overviewBusy || productsBusy;
    getControl('products-more').textContent = productsBusy ? '正在读取…' : '加载更多商品';
  }
  /** @param {import('./contracts.js').MerchantOrderSummary | import('./contracts.js').MerchantOrderDetail} order */
  function orderStatuses(order) {
    const group = node('div', undefined, 'merchant-order-statuses');
    const payment = node('div'); payment.append(node('small', '模拟付款'), status(paymentLabel(order.payment.status), order.payment.status === 'failed' ? 'error' : order.payment.status === 'unknown' ? 'warning' : ''));
    const fulfillment = node('div'); fulfillment.append(node('small', order.fulfillment.method === 'delivery' ? '制作 / 配送（模拟）' : '制作 / 取餐（模拟）'),
      status(fulfillmentLabel(order.fulfillment_status.status, order.fulfillment.method), order.fulfillment_status.status === 'cancelled' ? 'warning' : ''));
    group.append(payment, fulfillment); return group;
  }
  function renderOrders() {
    $('orders-list').replaceChildren();
    $('orders-state').hidden = Boolean(orders?.items.length);
    $('orders-state').textContent = overviewBusy ? '正在读取订单…' : orders ? '商家还没有已保存的订单。' : '订单数据当前不可用。';
    if (orders) for (const order of orders.items) {
      const card = node('article', undefined, 'merchant-order-card'); card.dataset.orderId = order.order_id;
      const heading = node('div', undefined, 'merchant-order-top'); const description = node('div');
      description.append(node('h3', order.items.map(item => `${item.title} × ${item.quantity}`).join('、')), node('p', `订单号：${order.order_id}`, 'order-id'), node('p', `创建于 ${time(order.created_at)}`, 'order-created'));
      heading.append(description, node('strong', money(order.total_minor, order.currency), 'merchant-order-total'));
      const bottom = node('div', undefined, 'merchant-order-meta'); const button = node('button', '查看订单详情', 'secondary'); button.type = 'button';
      button.dataset.orderId = order.order_id; button.addEventListener('click', () => { void showOrder(order.order_id); });
      bottom.append(orderStatuses(order), button); card.append(heading, node('p', `${methodLabel(order.fulfillment.method)} · 整单金额包含全部已记录费用`, 'order-method'), bottom);
      $('orders-list').append(card);
    }
    $('order-total').textContent = orders ? String(orders.total) : '—';
    $('orders-count').textContent = orders ? `已显示 ${orders.items.length} / ${orders.total} 笔订单` : '';
    getControl('orders-more').hidden = !orders?.has_more;
    getControl('orders-more').disabled = overviewBusy || ordersBusy;
    getControl('orders-more').textContent = ordersBusy ? '正在读取…' : '加载更多订单';
  }
  /** @param {HTMLElement} parent @param {string} label @param {string} value @param {string} [extra] */
  function line(parent, label, value, extra = '') {
    const row = node('div', undefined, `line-item ${extra}`); row.append(node('span', label), node('span', value)); parent.append(row); return row;
  }
  /** @param {HTMLElement} parent @param {string} title */
  function section(parent, title) { const result = node('section', undefined, 'detail-section'); result.append(node('h3', title)); parent.append(result); return result; }
  /** @param {import('./contracts.js').MerchantOrderDetail} order */
  function renderDetail(order) {
    const content = $('order-detail'); content.replaceChildren();
    const identity = section(content, '订单记录');
    line(identity, '订单号', order.order_id); line(identity, '创建时间', time(order.created_at)); line(identity, '更新记录', time(order.updated_at));
    const items = section(content, '商品与费用');
    for (const item of order.items) line(items, `${item.title} × ${item.quantity}`, `${money(item.unit_minor, order.currency)} × ${item.quantity} = ${money(item.line_total_minor, order.currency)}`);
    line(items, '商品小计', money(order.subtotal_minor, order.currency));
    for (const fee of order.fees) line(items, fee.label, money(fee.amount_minor, order.currency));
    line(items, '整单含费金额', money(order.total_minor, order.currency), 'total');
    const states = section(content, '付款与履约'); states.append(orderStatuses(order));
    line(states, '付款记录时间', time(order.payment.updated_at)); line(states, '履约记录时间', time(order.fulfillment_status.updated_at));
    const fulfillment = section(content, '履约信息'); line(fulfillment, '履约方式', methodLabel(order.fulfillment.method));
    if (order.fulfillment.method === 'delivery') {
      const delivery = order.fulfillment.delivery;
      if (delivery) { line(fulfillment, '收件人', delivery.recipient); line(fulfillment, '联系电话', delivery.phone); line(fulfillment, '配送地址', delivery.address); }
      else fulfillment.append(node('p', '这笔历史配送记录没有保存收件信息。', 'detail-note'));
    }
    content.append(node('p', '只读记录 · 本地模拟付款与履约', 'detail-note'));
  }
  /** @param {string} id */
  async function showOrder(id) {
    const version = ++detailVersion;
    $('order-detail').replaceChildren(node('p', '正在读取订单详情…', 'list-state'));
    if (!getDialog('order-dialog').open) getDialog('order-dialog').showModal();
    try {
      const order = await read(`${endpoint}/orders/${encodeURIComponent(id)}`, parseMerchantOrderDetail);
      if (version !== detailVersion || !getDialog('order-dialog').open) return;
      if (order.order_id !== id) throw unavailable();
      renderDetail(order);
    } catch (error) {
      if (version === detailVersion && getDialog('order-dialog').open) $('order-detail').replaceChildren(node('p', `订单详情不可用。${errorMessage(error, '商家数据暂时不可用。')}`, 'list-state'));
    }
  }
  async function refresh() {
    if (overviewBusy) return;
    const version = ++snapshotVersion; overviewBusy = true; productsBusy = false; ordersBusy = false;
    products = null; orders = null; notice();
    ++detailVersion; if (getDialog('order-dialog').open) getDialog('order-dialog').close(); $('order-detail').replaceChildren();
    getControl('merchant-refresh').disabled = true; getControl('merchant-refresh').textContent = '正在读取快照…';
    renderProducts(); renderOrders();
    try {
      const overview = await read(`${endpoint}/overview`, parseMerchantOverviewView);
      if (version !== snapshotVersion) return;
      products = overview.products; orders = overview.orders;
      $('checked-at').textContent = `上次成功读取：${time(new Date().toISOString())}`;
    } catch (error) {
      if (version === snapshotVersion) notice(errorMessage(error, '商家数据暂时不可用。'));
    } finally {
      if (version === snapshotVersion) { overviewBusy = false; getControl('merchant-refresh').disabled = false; getControl('merchant-refresh').textContent = '刷新商品与订单'; renderProducts(); renderOrders(); }
    }
  }
  /** @param {'products' | 'orders'} kind */
  async function more(kind) {
    const page = kind === 'products' ? products : orders;
    if (overviewBusy || !page?.has_more || (kind === 'products' ? productsBusy : ordersBusy)) return;
    const version = snapshotVersion, cursor = page.next_cursor;
    if (kind === 'products') productsBusy = true; else ordersBusy = true;
    notice(); renderProducts(); renderOrders();
    try {
      const path = `${endpoint}/${kind}?limit=20&cursor=${encodeURIComponent(cursor ?? '')}`;
      if (kind === 'products') {
        const previous = products;
        const next = await read(path, parseMerchantProductsPage);
        if (version !== snapshotVersion || !previous) return;
        products = mergePage(previous, next, (item) => item.entry_id);
      } else {
        const previous = orders;
        const next = await read(path, parseMerchantOrdersPage);
        if (version !== snapshotVersion || !previous) return;
        orders = mergePage(previous, next, (item) => item.order_id);
      }
    } catch (error) {
      if (version === snapshotVersion) notice(`分页数据读取失败，已显示的记录仍为此前读取结果。${errorMessage(error, '商家数据暂时不可用。')}`);
    } finally {
      if (version === snapshotVersion) { if (kind === 'products') productsBusy = false; else ordersBusy = false; renderProducts(); renderOrders(); }
    }
  }
  /**
   * @template T
   * @param {{items: T[], total: number, has_more: boolean, next_cursor: string | null}} previous
   * @param {{items: T[], total: number, has_more: boolean, next_cursor: string | null}} next
   * @param {(item: T) => string} identify
   */
  function mergePage(previous, next, identify) {
    const items = [...previous.items, ...next.items];
    if (items.length > next.total || new Set(items.map(identify)).size !== items.length
      || (next.has_more && next.next_cursor === previous.next_cursor)) throw unavailable();
    return { ...next, items };
  }
  /** @param {'products' | 'orders'} kind */
  function switchTab(kind) {
    for (const name of ['products', 'orders']) {
      const selected = name === kind;
      $(`${name}-tab`).setAttribute('aria-selected', String(selected)); $(`${name}-tab`).tabIndex = selected ? 0 : -1; $(`${name}-panel`).hidden = !selected;
    }
  }
  for (const [index, kind] of /** @type {const} */ (['products', 'orders']).entries()) {
    $(`${kind}-tab`).addEventListener('click', () => switchTab(kind));
    $(`${kind}-tab`).addEventListener('keydown', event => {
      if (!(event instanceof KeyboardEvent) || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); const target = event.key === 'Home' ? 'products' : event.key === 'End' ? 'orders' : index === 0 ? 'orders' : 'products';
      switchTab(target); $(`${target}-tab`).focus();
    });
    $(`${kind}-more`).addEventListener('click', () => { void more(kind); });
  }
  getControl('merchant-refresh').addEventListener('click', () => { void refresh(); });
  $('detail-close').addEventListener('click', () => getDialog('order-dialog').close());
  getDialog('order-dialog').addEventListener('close', () => {
    // A queued close event from the previous opening must not clear a newly opened detail.
    if (getDialog('order-dialog').open) return;
    ++detailVersion; $('order-detail').replaceChildren();
  });
  void refresh();
