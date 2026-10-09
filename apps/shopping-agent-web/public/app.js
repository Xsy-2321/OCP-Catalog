import { isPendingPurchase, parseSessionView, parseConfigView, parseAgentRunView, parsePendingSessionsView } from './contracts.js';
import { getElement as $, getControl, getField, getInput, node } from './dom.js';
import { ApiError, errorMessage, request } from './api-client.js';
import { createPageState, deriveViewModel, draftFromSession, draftQuantity } from './view-model.js';

  const storageKey = 'ocp-shopping-session-id';
  const updateKey = 'ocp-shopping-update';
  const state = createPageState();
  const entryUrl = new URL(window.location.href);
  const startAtRequest = entryUrl.searchParams.get('start') === '1';
  if (startAtRequest) {
    // Only the portal may start a fresh view after payment; ordinary reloads restore it.
    entryUrl.searchParams.delete('start');
    window.history.replaceState(window.history.state, '', `${entryUrl.pathname}${entryUrl.search}${entryUrl.hash}`);
  }
  // Viewing an earlier card never changes the purchase facts or advances the workflow.
  let shownStep = 0;
  let focusStep = false;
  let leavingTimer = 0;
  /** @param {number} step @param {boolean} [focus] */
  function showStep(step, focus = true) {
    if (step === shownStep) { focusStep ||= focus; return; }
    const previous = $(`flow-panel-${shownStep}`);
    document.querySelectorAll('.is-leaving').forEach(panel => panel.classList.remove('is-leaving'));
    previous.classList.add('is-leaving');
    clearTimeout(leavingTimer);
    leavingTimer = window.setTimeout(() => previous.classList.remove('is-leaving'), 320);
    shownStep = step; focusStep = focus;
  }
  function fitStep() {
    $('flow-viewport').style.height = `${$(`flow-panel-${shownStep}`).offsetHeight}px`;
  }
  function renderFlow() {
    document.querySelectorAll('[data-step]').forEach(element => {
      if (!(element instanceof HTMLButtonElement)) return;
      const step = Number(element.dataset.step);
      element.classList.toggle('active', step === shownStep);
      element.disabled = (state.uiStatus.busy && !state.uiStatus.backgroundChecking) || step >= shownStep;
      if (step === shownStep) element.setAttribute('aria-current', 'step');
      else element.removeAttribute('aria-current');
    });
    document.querySelectorAll('[data-flow-panel]').forEach(element => {
      if (!(element instanceof HTMLElement)) return;
      const active = Number(element.dataset.flowPanel) === shownStep;
      element.classList.toggle('is-active', active);
      element.inert = !active;
      element.setAttribute('aria-hidden', String(!active));
    });
    getControl('flow-back').disabled = (state.uiStatus.busy && !state.uiStatus.backgroundChecking) || shownStep === 0;
    $('flow-progress').textContent = `第 ${shownStep + 1} 步，共 4 步`;
    $('flow-track').style.transform = `translateX(-${shownStep * 100}%)`;
    // The explanation follows the current result card, without duplicating its IDs or stale advice.
    if (shownStep > 0) $(`flow-panel-${shownStep}`).querySelector('[data-flow-context]')?.append($('planning-section'));
    fitStep();
    if (focusStep) {
      focusStep = false;
      $(`flow-panel-${shownStep}`).querySelector('h2')?.focus({ preventScroll: true });
    }
  }
  /** @param {number} minor */
  const money = minor => `¥${(minor / 100).toFixed(2)}`;
  /** @param {string} text @param {string} [kind] */
  function showNotice(text, kind = '') {
    $('notice').textContent = text; $('notice').className = kind; $('notice').hidden = !text;
  }
  /** @param {string} text @param {string} [kind] */
  function notify(text, kind = '') {
    state.uiStatus.transient = { text, kind };
    const view = deriveViewModel(state, Date.now());
    showNotice(view.notice.text, view.notice.kind);
  }
  /** @param {string} path @param {Record<string, unknown> | undefined} [body] */
  const api = (path, body) => request(path, parseSessionView, body);
  const unresolved = isPendingPurchase;
  const locked = () => deriveViewModel(state, Date.now()).locked;
  const llmReady = () => state.configuration?.llm_status === 'configured';
  const mixedManual = () => state.draft.mode === 'manual' && state.draft.mixed;
  /** @param {NonNullable<import('./contracts.js').SessionView['quote']>} quote */
  const quoteItems = quote => quote.items || [{ entry_id: quote.entry_id, title: quote.title,
    quantity: quote.quantity, unit_price_minor: quote.unit_price_minor,
    line_total_minor: quote.unit_price_minor * quote.quantity }];
  function captureDraft() {
    state.draft.query = getField('query').value.trim();
    state.draft.message = getField('agent-message').value.trim();
    state.draft.budget = getField('budget').value.trim();
    state.draft.quantity = Number(getInput('quantity').value);
    state.draft.mixed = getInput('mixed-basket').checked;
    state.draft.fulfillment = getField('fulfillment').value === 'delivery' ? 'delivery' : 'pickup';
    state.draft.delivery = { recipient: getField('delivery-recipient').value.trim(),
      phone: getField('delivery-phone').value.trim().replace(/[ -]/g, ''), address: getField('delivery-address').value.trim() };
    if (mixedManual()) {
      state.draft.quantity = draftQuantity(state.draft);
      // Input orchestration owns form values; render consumes the draft snapshot.
      getInput('quantity').value = String(state.draft.quantity);
    }
  }
  function dirty() {
    captureDraft();
    state.draft.changed = true;
    state.plannerResult = null;
    render();
  }
  function addBasketLine(query = '', quantity = 1) {
    const item = { query, quantity };
    state.draft.items.push(item);
    renderBasketLine(item);
  }
  /** @param {import('./view-model.js').DraftItem} item */
  function renderBasketLine(item) {
    const row = node('div', undefined, 'basket-input-row');
    const queryLabel = node('label', '商品关键词');
    const queryInput = node('input'); queryInput.className = 'basket-query'; queryInput.maxLength = 500; queryInput.value = item.query;
    const quantityLabel = node('label', '杯数');
    const quantityInput = node('input'); quantityInput.className = 'basket-quantity'; quantityInput.type = 'number';
    quantityInput.min = '1'; quantityInput.max = '20'; quantityInput.value = String(item.quantity);
    const remove = node('button', '移除', 'secondary'); remove.type = 'button'; remove.classList.add('remove-basket-line');
    remove.addEventListener('click', () => {
      const index = state.draft.items.indexOf(item);
      if (index >= 0) state.draft.items.splice(index, 1);
      row.remove();
      dirty();
    });
    queryLabel.append(queryInput); quantityLabel.append(quantityInput); row.append(queryLabel, quantityLabel, remove);
    queryInput.addEventListener('input', () => { item.query = queryInput.value.trim(); dirty(); });
    quantityInput.addEventListener('input', () => { item.quantity = Number(quantityInput.value); dirty(); });
    $('basket-lines').append(row);
  }
  /** @param {HTMLElement} parent @param {'pickup' | 'delivery' | undefined} fulfillment @param {import('./view-model.js').Delivery | undefined} delivery */
  function renderDelivery(parent, fulfillment, delivery) {
    line('履约方式', fulfillment === 'delivery' ? '配送（本地模拟）' : '到店自取', parent);
    if (fulfillment === 'delivery' && delivery) {
      line('收件人', `${delivery.recipient} · ${delivery.phone}`, parent);
      line('配送地址', delivery.address, parent);
    }
  }

  /** @param {import('./view-model.js').Draft} draft */
  function renderDraftForm(draft) {
    document.querySelectorAll('[name="flow-mode"]').forEach(element => {
      if (element instanceof HTMLInputElement) element.checked = element.value === draft.mode;
    });
    getField('query').value = draft.query;
    getField('agent-message').value = draft.message;
    getField('budget').value = draft.budget;
    getInput('quantity').value = String(draft.quantity);
    getInput('mixed-basket').checked = draft.mixed;
    $('basket-lines').replaceChildren();
    for (const item of draft.items) renderBasketLine(item);
    getField('fulfillment').value = draft.fulfillment;
    for (const key of /** @type {const} */ (['recipient', 'phone', 'address'])) getField(`delivery-${key}`).value = draft.delivery[key];
  }
  function restoreForm() {
    if (!state.serverSession) return;
    state.draft = draftFromSession(state.serverSession, state.draft);
    renderDraftForm(state.draft);
  }
  /** @param {import('./contracts.js').SessionView} value @param {boolean} [restore] */
  function adopt(value, restore = false) {
    const previousStep = deriveViewModel(state, Date.now()).step;
    const previousId = state.serverSession?.id;
    if (state.serverSession?.id !== value.id) state.uiStatus.basketChoices.clear();
    if (state.serverSession?.id !== value.id || state.serverSession?.phase !== value.phase
      || state.serverSession?.quote?.quote_id !== value.quote?.quote_id || state.serverSession?.quote?.terms_hash !== value.quote?.terms_hash
      || state.serverSession?.attempt?.purchase_attempt_id !== value.attempt?.purchase_attempt_id) state.plannerResult = null;
    state.serverSession = value;
    state.uiStatus.basketChanged = false;
    if (state.serverSession.selected_entry_ids) state.serverSession.selected_entry_ids.forEach((id, index) => state.uiStatus.basketChoices.set(index, id));
    else if (state.serverSession.selected_items && state.serverSession.candidate_groups) {
      // Match each requested group to a selected product without changing its quantity.
      const selections = state.serverSession.selected_items;
      state.serverSession.candidate_groups.forEach((group, index) => {
        const selected = selections.find(item => group.candidates.some(candidate => candidate.entry_id === item.candidate.entry_id));
        if (selected) state.uiStatus.basketChoices.set(index, selected.candidate.entry_id);
      });
    }
    if (restore) restoreForm();
    const nextStep = deriveViewModel(state, Date.now()).step;
    if ((previousId !== value.id || previousStep !== nextStep) && (!value.error || value.attempt)) showStep(nextStep, false);
  }
  function remember(broadcast = false) {
    // A successful old tab must never replace the pointer to a known pending purchase.
    // All tabs persist the same server-ordered first item, even when viewing different pending purchases.
    const pending = state.uiStatus.pendingSessions[0];
    const target = pending || (!state.uiStatus.pendingCheckFailed || (state.serverSession && unresolved(state.serverSession)) || state.uiStatus.transportUncertain ? state.serverSession : null);
    try {
      if (target && localStorage.getItem(storageKey) !== target.id) localStorage.setItem(storageKey, target.id);
      if (broadcast) localStorage.setItem(updateKey, `${Date.now()}:${Math.random()}`);
    } catch { /* Server-side pending discovery remains available without local storage. */ }
  }
  async function syncPending({ recover = false } = {}) {
    try {
      const result = await request('/api/sessions/pending', parsePendingSessionsView);
      state.uiStatus.pendingSessions = result.sessions.filter(unresolved);
      state.uiStatus.pendingCheckFailed = false;
      const pending = state.uiStatus.pendingSessions.find(value => value.id === state.serverSession?.id) || state.uiStatus.pendingSessions[0];
      if (pending) {
        const changed = state.serverSession?.id !== pending.id;
        adopt(pending, changed);
        if (recover) {
          adopt(await api(`/api/sessions/${pending.id}/recover`, {}));
          state.uiStatus.transportUncertain = false;
          state.uiStatus.pendingSessions = (await request('/api/sessions/pending', parsePendingSessionsView)).sessions.filter(unresolved);
        }
      } else if (state.serverSession && unresolved(state.serverSession)) {
        // Another tab may already have recovered this purchase. Refresh its saved state without changing a draft.
        adopt(await api(`/api/sessions/${state.serverSession.id}`));
      }
      if (pending) remember();
    } catch (error) { state.uiStatus.pendingCheckFailed = true; throw error; }
  }
  async function updateConfiguration() {
    try {
      state.configuration = await request('/api/config', parseConfigView);
      state.uiStatus.connectionFailed = false;
    } catch (error) { state.uiStatus.connectionFailed = true; throw error; }
  }
  function renderConfiguration() {
    $('demo-navigation').hidden = state.uiStatus.connectionFailed || state.configuration?.merchant_demo_available !== true;
    const health = state.configuration?.merchant_health;
    const offline = state.uiStatus.connectionFailed || health?.status === 'offline';
    $('connection-badge').classList.toggle('offline', offline);
    $('mode-label').textContent = state.uiStatus.connectionFailed ? '连接状态待检查'
      : state.configuration?.mode === 'mock' ? '本地演示'
      : health?.status === 'online' ? '商家在线' : health?.status === 'offline' ? '商家暂不可达' : '正在检查连接';
    const connection = state.uiStatus.connectionFailed ? '连接状态未能确认，请重新检查。'
      : health?.status === 'offline' ? '暂时无法连接商家，请稍后重新检查。'
      : health?.status === 'online' ? '已连接本地咖啡店。' : '固定样例流程 · 本地模拟付款';
    const model = llmReady() ? 'Agent 可以帮你选择咖啡' : 'Agent 暂不可用，可使用关键词检索';
    $('runtime-note').textContent = `${connection}\n${model}\n本地模拟付款 · 每笔由你确认`;
    $('model-note').textContent = llmReady()
      ? 'Agent 会理解偏好、查询并推荐。可同时要不同商品，总预算和总杯数由表单限定。'
      : 'Agent 暂不可用，现在可切换为关键词检索。';
    getControl('connection-check').disabled = state.uiStatus.busy;
  }
  function renderPending() {
    getControl('pending-check').disabled = state.uiStatus.busy;
    $('recovery-card').hidden = !state.uiStatus.pendingCheckFailed && !state.uiStatus.pendingSessions.length && !state.uiStatus.transportUncertain;
    $('pending-note').textContent = state.uiStatus.pendingCheckFailed
      ? '暂时无法检查未决购买。请点击“查找未决购买”重试，确认前暂停新购买。'
      : state.uiStatus.pendingSessions.length ? '此浏览器身份仍有购买结果待查询。请先恢复原尝试，勿重新购买。'
      : '此浏览器身份没有待处理的购买；跨标签页或刷新后可在这里找回。';
    $('pending-list').replaceChildren();
    for (const pending of state.uiStatus.pendingSessions) {
      const row = node('div', undefined, 'pending-row');
      const description = node('div');
      description.append(node('strong', `${pending.quote?.title || pending.intent.query} × ${pending.intent.quantity}`),
        node('small', '购买结果待查询，请恢复原购买。', 'helper-text'));
      const button = node('button', '恢复这笔购买', 'secondary'); button.type = 'button'; button.disabled = state.uiStatus.busy;
      button.addEventListener('click', () => recoverPending(pending.id));
      row.append(description, button); $('pending-list').append(row);
    }
  }
  /** @param {ReturnType<typeof deriveViewModel>} view */
  function renderPlanning(view) {
    $('planning-section').hidden = !state.serverSession?.candidates.length && !state.serverSession?.quote && !state.plannerResult;
    $('planning-heading').textContent = state.plannerResult ? 'Agent 推荐依据' : '这次选择的依据';
    $('planning-explanation').textContent = state.plannerResult?.explanation || (state.serverSession?.selected
      ? `已选择${state.serverSession.selected_items?.length ? state.serverSession.selected_items.map(item => `「${item.candidate.title}」× ${item.quantity}`).join('、') : `「${state.serverSession.selected.title}」`}。目录价用于初步筛选，购买前仍需核对最终含费报价。`
      : state.serverSession ? `按“${state.serverSession.intent.query}”检索，预算为 ${money(state.serverSession.intent.max_total_minor)}，数量为 ${state.serverSession.intent.quantity} 杯。` : '');
    $('safety-steps').replaceChildren();
    if (!state.serverSession) return;
    const steps = [
      `已发现 ${state.serverSession.candidates.length} 个符合目录价格、币种和库存要求的候选。`,
      state.serverSession.quote ? `商家最终含费报价 ${money(state.serverSession.quote.total_minor)}，预算上限 ${money(state.serverSession.intent.max_total_minor)}。` : '选择候选后，向商家取得最终含费报价。',
      unresolved(state.serverSession) ? '保留原购买尝试，只查询结果，不重复结账。'
        : state.serverSession.phase === 'confirmed' ? '本次购买已由你确认，付款与取餐状态分别显示。' : '等待你明确确认后才会执行结账。',
    ];
    for (const step of steps) $('safety-steps').append(node('li', step));
    const actions = { confirm_quote: '在报价区确认并模拟购买', choose_candidate: '在候选区查看最终报价', edit_request: '修改需求后重新提交' };
    const available = view.nextActions.map(action => actions[action]);
    if (available.length) $('safety-steps').append(node('li', `接下来可以：${available.join('；')}。`));
    const warnings = new Set([...(state.serverSession.search_warnings || []), ...(state.plannerResult?.warnings || [])]);
    for (const warning of warnings) $('safety-steps').append(node('li', `查询范围提示：${warning}`));
  }
  function render() {
    const view = deriveViewModel(state, Date.now());
    const { phase, mixed, delivery, groups, grouped } = view;
    ['query', 'agent-message', 'budget', 'quantity', 'mixed-basket', 'fulfillment', 'delivery-recipient', 'delivery-phone', 'delivery-address'].forEach(id => { getControl(id).disabled = !view.actions.edit; });
    $('single-query').hidden = mixed; $('basket-editor').hidden = !mixed;
    getInput('quantity').readOnly = mixed;
    for (const element of $('basket-lines').querySelectorAll('input,button')) {
      if (!(element instanceof HTMLInputElement || element instanceof HTMLButtonElement)) continue;
      element.disabled = !mixed || !view.actions.edit;
      if (element instanceof HTMLInputElement) element.required = mixed;
      if (element.classList.contains('remove-basket-line')) element.disabled ||= state.draft.items.length <= 2;
    }
    getControl('add-basket-line').disabled = !view.actions.edit || state.draft.items.length >= 10;
    $('delivery-fields').hidden = !delivery;
    for (const id of ['delivery-recipient', 'delivery-phone', 'delivery-address']) { getField(id).required = delivery; getControl(id).disabled ||= !delivery; }
    document.querySelectorAll('[name="flow-mode"]').forEach(element => { if (element instanceof HTMLInputElement) element.disabled = !view.actions.edit; });
    $('manual-controls').hidden = state.draft.mode !== 'manual'; $('agent-controls').hidden = state.draft.mode !== 'agent';
    getField('query').required = state.draft.mode === 'manual' && !mixed; getField('agent-message').required = state.draft.mode === 'agent';
    getControl('search-button').textContent = state.uiStatus.busy && state.draft.mode === 'agent' ? '正在规划…' : state.draft.mode === 'agent' ? '让 Agent 规划 ↗' : '寻找咖啡 ↗';
    getControl('search-button').disabled = !view.actions.search;
    $('draft-note').hidden = !view.draftNoteVisible;
    $('empty').hidden = !state.serverSession || state.serverSession.candidates.length > 0 || Boolean(state.serverSession.candidate_groups?.length);
    if (!$('empty').hidden) $('empty').querySelector('p')?.replaceChildren(document.createTextNode('暂时没有合适的咖啡，返回上一步调整需求或预算。'));
    $('candidates-section').hidden = !state.serverSession || (!state.serverSession.candidates.length && !state.serverSession.candidate_groups?.length);
    $('candidates').replaceChildren();
    groups.forEach((group, index) => {
      if (grouped) $('candidates').append(node('h3', `${index + 1}. ${group.query} × ${group.quantity} 杯`, 'candidate-group-heading'));
      if (!group.candidates.length && grouped) $('candidates').append(node('p', '此项没有满足关键词、库存和履约要求的候选，请修改需求。', 'candidate-group-heading'));
      for (const candidate of group.candidates) {
      const selected = grouped ? state.uiStatus.basketChoices.get(index) === candidate.entry_id : state.serverSession?.selected?.entry_id === candidate.entry_id;
      const card = node('article', undefined, `coffee-card${selected ? ' selected' : ''}`);
      card.append(node('span', '☕', 'coffee-icon'), node('h3', candidate.title), node('p', candidate.description));
      const bottom = node('div', undefined, 'card-bottom');
      const price = node('span', money(candidate.search_price_minor), 'price'); price.append(node('small', '/ 杯 · 目录价'));
      const button = node('button', grouped ? selected ? '已选入购物篮' : '选入购物篮' : '查看最终报价', 'secondary'); button.type = 'button';
      button.dataset.groupIndex = String(index); button.dataset.entryId = candidate.entry_id;
      button.disabled = !view.actions.quote;
      button.addEventListener('click', () => {
        if (!grouped) { void action('quote', { entry_id: candidate.entry_id }); return; }
        state.uiStatus.basketChoices.set(index, candidate.entry_id); state.uiStatus.basketChanged = true; state.plannerResult = null; render();
      });
      bottom.append(price, button); card.append(bottom); $('candidates').append(card);
      }
    });
    if (grouped) {
      const button = node('button', '查看整单最终报价', 'primary'); button.type = 'button'; button.id = 'basket-quote-button';
      button.disabled = !view.actions.basketQuote;
      button.addEventListener('click', () => { void action('quote', { entry_ids: groups.map((_group, index) => state.uiStatus.basketChoices.get(index)) }); });
      $('candidates').append(button);
    }
    $('quote-section').hidden = !view.quoteVisible;
    $('quote-content').replaceChildren();
    if (state.serverSession?.quote) {
      const quote = state.serverSession.quote;
      $('quote-content').append(node('h3', quoteItems(quote).length > 1 ? `整单共 ${quote.quantity} 杯` : `${quote.title} × ${quote.quantity}`, 'quote-title'));
      for (const item of quoteItems(quote)) line(`${item.title} × ${item.quantity}`, `${money(item.unit_price_minor)} × ${item.quantity} = ${money(item.line_total_minor)}`, $('quote-content'));
      for (const fee of quote.fees) line(fee.label, money(fee.amount_minor), $('quote-content'));
      const total = line('最终含费总额', money(quote.total_minor), $('quote-content'), 'total');
      total.lastChild?.replaceWith(node('strong', money(quote.total_minor)));
      line('你的总预算', money(state.serverSession.intent.max_total_minor), $('quote-content'));
      renderDelivery($('quote-content'), quote.fulfillment, quote.delivery);
    }
    getControl('cancel-button').disabled = !view.actions.cancel;
    $('order-section').hidden = !view.orderVisible;
    $('order-content').replaceChildren();
    if (state.serverSession?.attempt) {
      $('order-heading').textContent = phase === 'confirmed' ? '模拟订单已确认' : state.serverSession.attempt.status === 'failed' ? '本次模拟购买未成功' : '购买结果待查询';
      if (state.serverSession.order) {
        const order = state.serverSession.order;
        if (order.items?.length) for (const item of order.items) line(`${item.title} × ${item.quantity}`, money(item.line_total_minor), $('order-content'));
        else line(`${order.title} × ${order.quantity}`, money(order.total_minor), $('order-content'));
        line('订单总额（含费用）', money(order.total_minor), $('order-content'));
        renderDelivery($('order-content'), order.fulfillment || state.serverSession.quote?.fulfillment, order.delivery || state.serverSession.quote?.delivery);
        const grid = node('div', undefined, 'status-grid');
        for (const [label, value] of [['模拟付款', { paid: '模拟已支付', pending: '处理中', failed: '失败', unknown: '结果未知' }[order.payment_status]],
          [order.fulfillment === 'delivery' ? '制作 / 配送（模拟）' : '制作 / 取餐', { pending: '待履约', preparing: '制作中', ready: order.fulfillment === 'delivery' ? '待配送' : '待取餐', collected: order.fulfillment === 'delivery' ? '已交付' : '已取餐', completed: order.fulfillment === 'delivery' ? '已送达' : '已取餐', cancelled: '已取消' }[order.fulfillment_status]]]) {
          const cell = node('div', undefined, 'status-cell'); cell.append(node('small', label), node('span', value)); grid.append(cell);
        }
        $('order-content').append(grid, node('p', `订单号：${order.order_id}`, 'order-id'));
      }
    }
    if (state.uiStatus.transportUncertain && !state.serverSession?.attempt) {
      $('order-heading').textContent = '购买结果待查询';
      $('order-content').append(node('p', '确认请求尚无确定结果，请查询原购买。', 'helper-text'));
    }
    getControl('recover-button').disabled = !view.actions.recover;
    showNotice(view.notice.text, view.notice.kind);
    renderConfiguration(); renderPending(); renderTimeSensitive(view); renderFlow();
  }
  /** @param {string} label @param {string} value @param {HTMLElement} parent @param {string} [extra] */
  function line(label, value, parent, extra = '') {
    const row = node('div', undefined, `line-item ${extra}`); row.append(node('span', label), node('span', value)); parent.append(row); return row;
  }
  /** @param {ReturnType<typeof deriveViewModel>} view */
  function renderExpiry(view) {
    $('expiry').textContent = state.serverSession?.quote ? view.expiry : '';
    getControl('confirm-button').disabled = !view.actions.confirm;
  }
  /** Keep all time-dependent regions on the same derived view without rebuilding the form or candidates.
   * @param {ReturnType<typeof deriveViewModel>} view
   */
  function renderTimeSensitive(view) { renderExpiry(view); renderPlanning(view); }
  function updateExpiry() { renderTimeSensitive(deriveViewModel(state, Date.now())); fitStep(); }
  function finish() {
    state.uiStatus.busy = false; state.uiStatus.backgroundChecking = false; render();
    if (state.uiStatus.refreshQueued) { state.uiStatus.refreshQueued = false; void refreshStatus(false, true); }
  }
  async function refreshFacts(checkHealth = false) {
    try { await syncPending(); }
    catch { if (!state.uiStatus.transient.text) notify('未能检查未决购买，请点击“查找未决购买”重试。', 'warning'); }
    if (checkHealth) { try { await updateConfiguration(); } catch { /* Badge reports an unverified connection. */ } }
    remember(true);
  }
  /** @param {'quote' | 'confirm' | 'cancel' | 'recover'} name @param {Record<string, unknown>} [body] */
  async function action(name, body = {}) {
    if (state.uiStatus.busy || !state.serverSession) return;
    if (name === 'quote' && shownStep !== 1) return;
    const sessionId = state.serverSession.id;
    state.uiStatus.transient = { text: '', kind: '' }; state.uiStatus.busy = true; render();
    let failed = false;
    try {
      adopt(await api(`/api/sessions/${sessionId}/${name}`, body));
      if (name === 'quote') state.plannerResult = null; // A manual choice supersedes the model's earlier selection reason.
      state.uiStatus.transportUncertain = false;
      if (name === 'cancel') showStep(0);
      else if (name !== 'quote' || !state.serverSession?.error) showStep(deriveViewModel(state, Date.now()).step);
    }
    catch (error) {
      failed = true;
      if (name === 'confirm' && (!(error instanceof ApiError) || error.status >= 500)) {
        state.uiStatus.transportUncertain = true;
        showStep(3);
        try {
          adopt(await api(`/api/sessions/${sessionId}`));
          if (state.serverSession?.attempt) adopt(await api(`/api/sessions/${sessionId}/recover`, {}));
          state.uiStatus.transportUncertain = false;
          showStep(deriveViewModel(state, Date.now()).step);
        } catch { /* Keep the uncertainty lock until the original purchase can be queried. */ }
      } else notify(errorMessage(error, '连接暂时不可用，请重试查询。'), 'error');
    } finally { await refreshFacts(failed || Boolean(state.serverSession?.error)); finish(); }
  }
  /** @param {string} id */
  async function recoverPending(id) {
    if (state.uiStatus.busy) return;
    state.uiStatus.busy = true; state.uiStatus.transient = { text: '', kind: '' }; render();
    try {
      adopt(await api(`/api/sessions/${id}/recover`, {}), true);
      state.uiStatus.transportUncertain = false;
      showStep(deriveViewModel(state, Date.now()).step);
    } catch (error) { notify(errorMessage(error, '暂时无法查询原购买结果，请保留此记录。'), 'error'); }
    finally { await refreshFacts(true); finish(); }
  }
  async function refreshStatus(clearNotice = false, background = false) {
    if (state.uiStatus.busy) { state.uiStatus.refreshQueued = true; return; }
    if (clearNotice) state.uiStatus.transient = { text: '', kind: '' };
    state.uiStatus.backgroundChecking = background;
    state.uiStatus.busy = true; render();
    try { await syncPending(); await updateConfiguration(); }
    catch (error) { notify(errorMessage(error, '连接暂时不可用，请重试检查。'), 'error'); }
    finally { finish(); }
  }
  $('intent-form').addEventListener('submit', async event => {
    event.preventDefault(); if (shownStep !== 0 || state.uiStatus.busy || locked()) return;
    const value = state.draft.budget;
    if (!/^\d{1,5}(?:\.\d{1,2})?$/.test(value)) { notify('预算请输入最多两位小数的人民币金额。', 'error'); return; }
    const [whole, decimals = ''] = value.split('.');
    const minor = Number(whole) * 100 + Number(decimals.padEnd(2, '0'));
    const quantity = draftQuantity(state.draft);
    if (minor <= 0 || minor > 1000000 || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 20) { notify('请输入大于零且不超过10000元的预算，以及 1–20 杯的整数数量。', 'error'); return; }
    const message = state.draft.message;
    const query = state.draft.query;
    const items = mixedManual() ? state.draft.items : undefined;
    if (items && (items.length < 2 || items.length > 10 || items.some(item => !item.query
      || !Number.isSafeInteger(item.quantity) || item.quantity < 1))) {
      notify('请为购物篮的每一种商品填写关键词和正整数杯数。', 'error'); return;
    }
    const fulfillment = state.draft.fulfillment;
    const delivery = fulfillment === 'delivery' ? state.draft.delivery : undefined;
    if (delivery && (!delivery.recipient || !/^\+?[0-9]{6,15}$/.test(delivery.phone.replace(/[ -]/g, '')) || delivery.address.length < 5)) {
      notify('请填写收件人、有效联系电话和至少 5 个字的详细配送地址。', 'error'); return;
    }
    state.uiStatus.transient = { text: '', kind: '' }; state.uiStatus.busy = true; render();
    let failed = false;
    try {
      await syncPending();
      if (locked()) throw new Error('请先查询原购买结果，再提交新的需求。');
      if (!state.configuration) throw new Error('商家配置尚未加载，请重新检查连接。');
      if (state.draft.mode === 'agent') {
        if (!llmReady()) throw new Error('Agent 暂不可用，请切换为关键词检索。');
        const result = await request('/api/agent/run', parseAgentRunView, { message, max_total_minor: minor, quantity, fulfillment, ...(delivery ? { delivery } : {}) }, 120_000);
        adopt(result.session, true); state.plannerResult = result;
      } else {
        const created = await api('/api/sessions', { query: items ? items.map(item => item.query).join('、').slice(0, 500) : query,
          quantity, currency: 'CNY', max_total_minor: minor, merchant_id: state.configuration.merchant_id,
          fulfillment, ...(items ? { items } : {}), ...(delivery ? { delivery } : {}) });
        adopt(created, true);
        remember();
        adopt(await api(`/api/sessions/${created.id}/search`, {}));
      }
      state.draft.changed = false;
      if (!state.serverSession?.error) showStep(deriveViewModel(state, Date.now()).step);
    } catch (error) { failed = true; notify(errorMessage(error, '连接暂时不可用，请重试。'), 'error'); }
    finally { await refreshFacts(failed || Boolean(state.serverSession?.error)); finish(); }
  });
  for (const id of ['query', 'agent-message', 'budget', 'quantity', 'delivery-recipient', 'delivery-phone', 'delivery-address']) {
    $(id).addEventListener('input', dirty);
  }
  getField('fulfillment').addEventListener('change', dirty);
  getInput('mixed-basket').addEventListener('change', () => {
    if (getInput('mixed-basket').checked && !state.draft.items.length) {
      addBasketLine(getField('query').value.trim(), Number(getInput('quantity').value) || 1); addBasketLine();
    }
    dirty();
  });
  getControl('add-basket-line').addEventListener('click', () => { if (state.draft.items.length < 10) { addBasketLine(); dirty(); } });
  document.querySelectorAll('[name="flow-mode"]').forEach(element => element.addEventListener('change', () => {
    if (!(element instanceof HTMLInputElement)) return;
    state.draft.mode = element.value === 'agent' ? 'agent' : 'manual';
    captureDraft();
    render();
  }));
  getControl('confirm-button').addEventListener('click', () => {
    if (shownStep !== 2 || !state.serverSession?.quote || !deriveViewModel(state, Date.now()).actions.confirm) return;
    void action('confirm', { quote_id: state.serverSession.quote.quote_id, terms_hash: state.serverSession.quote.terms_hash, revision: state.serverSession.revision });
  });
  getControl('cancel-button').addEventListener('click', () => { void action('cancel'); });
  getControl('recover-button').addEventListener('click', () => { void action('recover'); });
  getControl('pending-check').addEventListener('click', () => { void refreshStatus(true); });
  getControl('connection-check').addEventListener('click', () => { void refreshStatus(true); });
  /** @param {number} target */
  function goBack(target) {
    if ((state.uiStatus.busy && !state.uiStatus.backgroundChecking) || !Number.isInteger(target) || target < 0 || target >= shownStep) return;
    showStep(target); renderFlow();
  }
  getControl('flow-back').addEventListener('click', () => goBack(shownStep - 1));
  document.querySelectorAll('[data-step]').forEach(element => element.addEventListener('click', () => goBack(Number(element.getAttribute('data-step')))));
  $('flow-track').addEventListener('transitionend', event => {
    if (event.target !== $('flow-track') || event.propertyName !== 'transform') return;
    document.querySelectorAll('.is-leaving').forEach(panel => panel.classList.remove('is-leaving'));
  });
  const flowObserver = new ResizeObserver(fitStep);
  document.querySelectorAll('[data-flow-panel]').forEach(panel => flowObserver.observe(panel));
  window.addEventListener('storage', event => { if ([storageKey, updateKey, null].includes(event.key)) void refreshStatus(); });
  window.addEventListener('focus', () => { void refreshStatus(false, true); });
  async function initialize() {
    state.uiStatus.busy = true; render();
    try { await updateConfiguration(); }
    catch (error) { notify(errorMessage(error, '暂时无法连接本地助手。'), 'error'); }
    try {
      // Server-side discovery takes priority over the single convenience pointer.
      try { await syncPending({ recover: true }); }
      catch (error) { notify(errorMessage(error, '暂时无法检查未决购买，请重试查询。'), 'warning'); }
      if (!state.serverSession) {
        let id;
        try { id = localStorage.getItem(storageKey); } catch { /* Pending discovery works without storage. */ }
        if (id) {
          try {
            const restored = await api(`/api/sessions/${encodeURIComponent(id)}`);
            adopt(restored, true);
            if (restored.attempt) adopt(await api(`/api/sessions/${restored.id}/recover`, {}));
          } catch (error) {
            if ((error instanceof ApiError ? error.status : undefined) === 404) {
              try { localStorage.removeItem(storageKey); } catch { /* Nothing to remove. */ }
              notify('原会话已不可访问，请开始新需求。', 'warning');
            } else throw error;
          }
        }
      }
      remember();
    } catch (error) { notify(errorMessage(error, '暂时无法恢复购买记录，请重试查询。'), 'error'); }
    finally {
      if (startAtRequest && !locked() && state.serverSession?.phase === 'confirmed'
        && state.serverSession.attempt?.status === 'confirmed'
        && state.serverSession.order?.payment_status === 'paid') {
        // Keep unpaid progress and uncertainty; reset only the projection of a paid purchase.
        state.serverSession = null;
        state.plannerResult = null;
        state.draft = createPageState().draft;
        state.uiStatus.basketChanged = false;
        state.uiStatus.basketChoices.clear();
        renderDraftForm(state.draft);
        showStep(0, false);
      } else if (state.serverSession) showStep(deriveViewModel(state, Date.now()).step, false);
      finish();
    }
  }
  captureDraft();
  render(); void initialize(); setInterval(updateExpiry, 1000);
