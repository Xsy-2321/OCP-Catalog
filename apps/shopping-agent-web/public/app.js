(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const storageKey = 'ocp-shopping-session-id';
  let session = null, busy = false, transportUncertain = false, transient = { text: '', kind: '' };
  const money = minor => `¥${(minor / 100).toFixed(2)}`;
  const node = (tag, text, className) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; if (className) element.className = className; return element; };
  function showNotice(text, kind = '') { $('notice').textContent = text; $('notice').className = kind; $('notice').hidden = !text; }
  function notify(text, kind = '') { transient = { text, kind }; showNotice(text, kind); }
  async function api(path, body) {
    const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json();
    if (!response.ok) { const error = new Error(result.error?.message || '操作暂时无法完成。'); error.code = result.error?.code; error.status = response.status; throw error; }
    return result;
  }
  const locked = () => Boolean(transportUncertain || (session && ['unknown', 'checkout_pending'].includes(session.phase)));
  function render() {
    const phase = session?.phase || 'new';
    const step = session?.attempt ? 3 : session?.quote ? 2 : session?.candidates?.length ? 1 : 0;
    document.querySelectorAll('[data-step]').forEach(element => element.classList.toggle('active', Number(element.dataset.step) === step));
    ['query', 'budget', 'quantity', 'search-button'].forEach(id => { $(id).disabled = busy || locked(); });
    $('empty').hidden = Boolean(session && phase !== 'new');
    $('candidates-section').hidden = !session || !session.candidates.length;
    $('candidates').replaceChildren();
    for (const candidate of session?.candidates || []) {
      const card = node('article', undefined, `coffee-card${session.selected?.entry_id === candidate.entry_id ? ' selected' : ''}`);
      card.append(node('span', '☕', 'coffee-icon'), node('h3', candidate.title), node('p', candidate.description));
      const bottom = node('div', undefined, 'card-bottom');
      const price = node('span', money(candidate.search_price_minor), 'price'); price.append(node('small', '/ 杯 · 目录价'));
      const button = node('button', '查看最终报价', 'secondary'); button.type = 'button';
      button.disabled = busy || locked() || Boolean(session.attempt) || phase === 'cancelled';
      button.addEventListener('click', () => action('quote', { entry_id: candidate.entry_id }));
      bottom.append(price, button); card.append(bottom); $('candidates').append(card);
    }
    $('quote-section').hidden = !session?.quote;
    $('quote-content').replaceChildren();
    if (session?.quote) {
      const quote = session.quote;
      $('quote-content').append(node('h3', `${quote.title} × ${quote.quantity}`, 'quote-title'));
      line('商品小计', `${money(quote.unit_price_minor)} × ${quote.quantity}`, $('quote-content'));
      for (const fee of quote.fees) line(fee.label, money(fee.amount_minor), $('quote-content'));
      const total = line('最终含费总额', money(quote.total_minor), $('quote-content'), 'total');
      total.lastChild.replaceWith(node('strong', money(quote.total_minor)));
      line('你的总预算', money(session.intent.max_total_minor), $('quote-content'));
      line('履约方式', '到店自取', $('quote-content'));
    }
    $('confirm-button').disabled = busy || transportUncertain || phase !== 'awaiting_confirmation' || Boolean(session?.attempt);
    $('cancel-button').disabled = busy || locked() || Boolean(session?.attempt) || phase === 'cancelled';
    $('order-section').hidden = !session?.attempt && !transportUncertain;
    $('order-content').replaceChildren();
    if (session?.attempt) {
      $('order-heading').textContent = phase === 'confirmed' ? '模拟订单已确认' : phase === 'failed' ? '本次模拟购买未成功' : '购买结果待查询';
      if (session.order) {
        const order = session.order;
        line(`${order.title} × ${order.quantity}`, money(order.total_minor), $('order-content'));
        const grid = node('div', undefined, 'status-grid');
        for (const [label, value] of [['模拟付款', { paid: '模拟已支付', pending: '处理中', failed: '失败' }[order.payment_status]],
          ['制作 / 取餐', { preparing: '制作中', ready: '待取餐', collected: '已取餐' }[order.fulfillment_status]]]) {
          const cell = node('div', undefined, 'status-cell'); cell.append(node('small', label), node('span', value)); grid.append(cell);
        }
        $('order-content').append(grid, node('p', `订单号：${order.order_id}`, 'order-id'));
      }
      $('order-content').append(node('p', `购买尝试：${session.attempt.purchase_attempt_id}`, 'order-id'));
    }
    if (transportUncertain && !session?.attempt) {
      $('order-heading').textContent = '购买结果待查询';
      $('order-content').append(node('p', '确认请求尚无确定结果，请查询当前会话。', 'order-id'));
    }
    $('recover-button').disabled = busy;
    if (transportUncertain) showNotice('确认请求的结果未知，请查询原购买结果；不要重新购买。', 'warning');
    else if (session?.error) showNotice(session.error.message, ['result_unknown', 'processing'].includes(session.error.code) ? 'warning' : 'error');
    else if (phase === 'cancelled') showNotice('本次购买已取消，没有执行结账。');
    else if (phase === 'confirmed') showNotice('模拟订单已确认。付款和制作状态以本地模拟商家返回的结果为准。');
    else if (phase === 'candidates' && !session.candidates.length) showNotice('没有符合目录价格、币种和库存要求的候选。请调整需求或预算。', 'warning');
    else showNotice(transient.text, transient.kind);
    updateExpiry();
  }
  function line(label, value, parent, extra = '') { const row = node('div', undefined, `line-item ${extra}`); row.append(node('span', label), node('span', value)); parent.append(row); return row; }
  function remember() { if (session) localStorage.setItem(storageKey, session.id); }
  function updateExpiry() {
    if (!session?.quote) return;
    const seconds = Math.max(0, Math.ceil((Date.parse(session.quote.expires_at) - Date.now()) / 1000));
    $('expiry').textContent = session.attempt ? '报价已绑定本次购买' : seconds ? `报价剩余 ${seconds} 秒` : '报价已过期，请重新报价';
    if (!seconds && !session.attempt) $('confirm-button').disabled = true;
  }
  async function action(name, body = {}) {
    if (busy || !session) return;
    transient = { text: '', kind: '' }; busy = true; render();
    try { session = await api(`/api/sessions/${session.id}/${name}`, body); transportUncertain = false; remember(); }
    catch (error) {
      if (name === 'confirm' && !error.status) {
        transportUncertain = true; notify('确认请求的结果未知，正在查询原购买尝试。请勿重新购买。', 'warning');
        try {
          session = await api(`/api/sessions/${session.id}`);
          if (session.attempt) session = await api(`/api/sessions/${session.id}/recover`, {});
          transportUncertain = false;
        } catch { /* Keep the local uncertainty lock until a successful query. */ }
      } else notify(error.message || '连接暂时不可用，请查询原结果。', 'error');
    } finally { busy = false; render(); }
  }
  $('intent-form').addEventListener('submit', async event => {
    event.preventDefault(); if (busy || locked()) return;
    const value = $('budget').value.trim();
    if (!/^\d{1,5}(?:\.\d{1,2})?$/.test(value)) { notify('预算请输入最多两位小数的人民币金额。', 'error'); return; }
    const [whole, decimals = ''] = value.split('.'); const minor = Number(whole) * 100 + Number(decimals.padEnd(2, '0'));
    transient = { text: '', kind: '' }; busy = true; render();
    try {
      session = await api('/api/sessions', { query: $('query').value, quantity: Number($('quantity').value), currency: 'CNY',
        max_total_minor: minor, merchant_id: 'coffee-demo', fulfillment: 'pickup' });
      remember(); session = await api(`/api/sessions/${session.id}/search`, {});
    } catch (error) { notify(error.message || '搜索连接暂时不可用。', 'error'); }
    finally { busy = false; render(); }
  });
  $('confirm-button').addEventListener('click', () => {
    if (!session?.quote || $('confirm-button').disabled) return;
    action('confirm', { quote_id: session.quote.quote_id, terms_hash: session.quote.terms_hash, revision: session.revision });
  });
  $('cancel-button').addEventListener('click', () => action('cancel'));
  $('recover-button').addEventListener('click', () => action('recover'));
  async function initialize() {
    busy = true; render();
    try {
      await api('/api/config');
      const id = localStorage.getItem(storageKey);
      if (id) {
        try { session = await api(`/api/sessions/${encodeURIComponent(id)}`); if (session.attempt) session = await api(`/api/sessions/${session.id}/recover`, {}); }
        catch (error) { if (error.status === 404) { localStorage.removeItem(storageKey); notify('原会话不属于当前浏览器身份，请开始新需求。', 'warning'); } else throw error; }
      }
    } catch (error) { notify(error.message || '暂时无法连接本地助手。', 'error'); }
    finally { busy = false; render(); }
  }
  render(); initialize(); setInterval(updateExpiry, 1000);
})();
