import { ApiError, request } from './api-client.js';
import { getElement, getControl, getField, getInput } from './dom.js';
import { readConfigurationDraft } from './view-model.js';

/** @typedef {'openai' | 'anthropic' | 'gemini'} Protocol */
/** @typedef {{ configured: boolean, protocol: Protocol, base_url: string, model: string, timeout_ms: number, has_api_key: boolean, source: 'local' | 'none' }} Settings */
/** @typedef {{ protocol: Protocol, base_url: string, model: string }} Preset */
/** @type {Record<string, Preset>} */
const presets = {
  deepseek: { protocol: 'openai', base_url: 'https://api.deepseek.com', model: 'deepseek-flash' },
  openai: { protocol: 'openai', base_url: 'https://api.openai.com/v1', model: 'gpt-4.1-mini' },
  anthropic: { protocol: 'anthropic', base_url: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5' },
  gemini: { protocol: 'gemini', base_url: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash' },
};
const protocolNames = { openai: 'OpenAI 兼容', anthropic: 'Anthropic', gemini: 'Gemini' };
const formElement = getElement('model-settings-form');
const fieldsElement = getElement('model-settings-fields');
if (!(formElement instanceof HTMLFormElement) || !(fieldsElement instanceof HTMLFieldSetElement)) throw new Error('API 配置表单不可用。');
const form = formElement;
const fields = fieldsElement;
/** @type {Settings | null} */
let saved = null;
let busy = false;
let loadFailed = false;
/** @type {'loading' | 'configuration' | 'entries'} */
let activeView = 'loading';

/** @param {'configuration' | 'entries'} view @param {boolean} [focus] @param {boolean} [updateLocation] */
function showView(view, focus = false, updateLocation = false) {
  activeView = view;
  const configuration = view === 'configuration';
  getElement('demo-loading').hidden = true;
  getElement('api-configuration').hidden = !configuration;
  getElement('demo-entry-view').hidden = configuration;
  getElement('model-edit-config').hidden = configuration;
  if (updateLocation) {
    const address = new URL(window.location.href);
    address.hash = configuration ? 'api-configuration' : '';
    window.history.replaceState(window.history.state, '', `${address.pathname}${address.search}${address.hash}`);
  }
  renderStatus();
  if (focus) {
    getElement(configuration ? 'api-configuration-heading' : 'demo-entry-heading').focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
}

/** @param {unknown} value @returns {Settings} */
function parseSettings(value) {
  if (typeof value !== 'object' || value === null) throw new Error('本机返回的配置格式不正确，请重新读取。');
  const result = /** @type {Record<string, unknown>} */ (value);
  if (typeof result.configured !== 'boolean' || !['openai', 'anthropic', 'gemini'].includes(String(result.protocol))
    || typeof result.base_url !== 'string' || typeof result.model !== 'string'
    || typeof result.timeout_ms !== 'number' || !Number.isFinite(result.timeout_ms)
    || typeof result.has_api_key !== 'boolean' || !['local', 'none'].includes(String(result.source))) {
    throw new Error('本机返回的配置格式不正确，请重新读取。');
  }
  return /** @type {Settings} */ (result);
}

/** @param {unknown} value @returns {{ ok: true, message: string }} */
function parseTest(value) {
  if (typeof value !== 'object' || value === null) throw new Error('未能确认测试结果，请重试。');
  const result = /** @type {Record<string, unknown>} */ (value);
  if (result.ok !== true || typeof result.message !== 'string') throw new Error('未能确认测试结果，请重试。');
  return { ok: true, message: result.message };
}

/** @param {string} value */
function normalizedBase(value) {
  return value.trim().replace(/\/+$/, '');
}

function currentProtocol() {
  const value = getField('model-protocol').value;
  return value === 'anthropic' || value === 'gemini' ? value : 'openai';
}

function canKeepKey() {
  return Boolean(saved?.has_api_key && currentProtocol() === saved.protocol
    && normalizedBase(getInput('model-base-url').value) === normalizedBase(saved.base_url));
}

function updateKeyHint() {
  const keep = canKeepKey();
  getInput('model-api-key').required = !keep;
  if (keep) getInput('model-api-key').setCustomValidity('');
  getInput('model-api-key').placeholder = keep ? '已保存密钥；留空可继续使用，填写则替换' : '粘贴该服务的 API 密钥';
  getElement('model-key-note').textContent = keep
    ? '本机已保存密钥，当前协议与地址未变时留空可保留。密钥不会回传到页面，也不会写入浏览器存储。'
    : saved?.has_api_key ? '协议或服务地址已改变，请重新填写对应密钥。密钥只提交给本机服务，保存后输入框会清空。'
      : '密钥只提交给本机服务，不写入浏览器存储；保存后输入框会清空。';
}

function renderStatus() {
  const status = getElement('model-settings-status');
  status.className = `model-status${loadFailed ? ' error' : saved?.configured ? ' configured' : ''}`;
  status.textContent = loadFailed ? '读取失败'
    : saved?.configured ? `已配置 · ${protocolNames[saved.protocol]}` : '待配置 API';
  getElement('model-first-run').hidden = saved?.configured === true || loadFailed;
  getControl('model-clear').disabled = busy || !saved?.has_api_key;
  getControl('model-back-to-entry').hidden = !saved?.configured;
  getControl('model-back-to-entry').disabled = busy || loadFailed;
  let returningToShopping = false;
  try { returningToShopping = readConfigurationDraft(sessionStorage) !== null; } catch { /* The original tab works without storage. */ }
  getElement('model-return-shopping').hidden = !returningToShopping;
  getElement('user-demo-entry').setAttribute('href', returningToShopping ? '/' : '/?start=1');
  updateKeyHint();
}

/** @param {string} message @param {string} [kind] */
function feedback(message, kind = '') {
  const element = getElement('model-settings-feedback');
  element.textContent = message;
  element.className = `model-settings-feedback ${kind}`.trim();
  element.hidden = !message;
}

/** @param {unknown} error */
function readableError(error) {
  if (error instanceof ApiError) return error.message;
  if (error instanceof DOMException && error.name === 'AbortError') return '请求超时，请检查服务地址或稍后重试。';
  if (error instanceof TypeError) return '暂时无法连接本机服务，请检查服务是否已启动后重试。';
  return error instanceof Error ? error.message : '配置操作暂时无法完成，请重试。';
}

/** @param {boolean} value @param {string} [message] */
function setBusy(value, message = '') {
  busy = value;
  fields.disabled = value;
  getElement('api-configuration').setAttribute('aria-busy', String(value));
  for (const id of ['model-reload', 'model-clear-confirm', 'model-clear-cancel']) getControl(id).disabled = value;
  if (value && message) feedback(message);
  renderStatus();
}

function resetKey() {
  const key = getInput('model-api-key');
  key.value = '';
  key.type = 'password';
  getControl('model-key-toggle').setAttribute('aria-pressed', 'false');
  getControl('model-key-toggle').setAttribute('aria-label', '显示 API 密钥');
  getControl('model-key-toggle').textContent = '显示';
}

/** @param {Settings} settings */
function fillSaved(settings) {
  saved = settings;
  loadFailed = false;
  const defaults = presets.deepseek;
  const protocol = settings.configured ? settings.protocol : defaults.protocol;
  const base = settings.configured ? settings.base_url : defaults.base_url;
  const model = settings.configured ? settings.model : defaults.model;
  const provider = Object.entries(presets).find(([, preset]) => preset.protocol === protocol
    && normalizedBase(preset.base_url) === normalizedBase(base))?.[0] ?? 'custom';
  getField('model-provider').value = provider;
  getField('model-protocol').value = protocol;
  getInput('model-base-url').value = base;
  getInput('model-name').value = model;
  getInput('model-timeout').value = String(settings.timeout_ms / 1000);
  resetKey();
  getElement('model-clear-confirmation').hidden = true;
  renderStatus();
}

/** @returns {Record<string, unknown>} */
function draft() {
  const key = getInput('model-api-key').value.trim();
  return { protocol: currentProtocol(), base_url: getInput('model-base-url').value.trim(),
    model: getInput('model-name').value.trim(), timeout_ms: Math.round(Number(getInput('model-timeout').value) * 1000),
    ...(key ? { api_key: key } : {}) };
}

function validDraft() {
  updateKeyHint();
  for (const id of ['model-base-url', 'model-name', 'model-api-key']) {
    const input = getInput(id);
    input.setCustomValidity(input.required && !input.value.trim() ? '请填写此项。' : '');
  }
  return form instanceof HTMLFormElement && form.reportValidity();
}

async function load() {
  if (busy) return;
  setBusy(true, '正在读取本机模型配置…');
  try {
    fillSaved(await request('/api/model-settings', parseSettings));
    feedback(saved?.configured ? '已读取本机配置。可测试当前连接，或修改后重新保存。' : '尚未配置 API。填写下方字段并保存，就可以启用 Agent。');
    const configuration = !saved?.configured || window.location.hash === '#api-configuration';
    showView(configuration ? 'configuration' : 'entries');
    if (configuration && window.location.hash === '#api-configuration') getElement('api-configuration-heading').focus({ preventScroll: true });
  } catch (error) { loadFailed = true; feedback(readableError(error), 'error'); showView('configuration'); }
  finally { setBusy(false); }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || !validDraft()) return;
  setBusy(true, '正在保存本机配置…');
  try {
    fillSaved(await request('/api/model-settings', parseSettings, draft()));
    feedback('本机配置已保存，密钥输入框已清空。', 'success');
    showView('entries', true, true);
  } catch (error) { feedback(readableError(error), 'error'); }
  finally { setBusy(false); }
});

getControl('model-test').addEventListener('click', async () => {
  if (busy || !validDraft()) return;
  const configuration = draft();
  setBusy(true, '正在测试连接与工具调用，可能需要几十秒…');
  try {
    const result = await request('/api/model-settings/test', parseTest, configuration, Number(configuration.timeout_ms) + 5000);
    feedback(`${result.message} 测试没有保存配置；修改后的字段请点击「保存本机配置」。`, 'success');
  } catch (error) { feedback(readableError(error), 'error'); }
  finally { setBusy(false); }
});

getField('model-provider').addEventListener('change', () => {
  const preset = presets[getField('model-provider').value];
  if (preset) {
    getField('model-protocol').value = preset.protocol;
    getInput('model-base-url').value = preset.base_url;
    getInput('model-name').value = preset.model;
  }
  resetKey();
  updateKeyHint();
  feedback(preset ? '已填入服务与模型示例，请填写自己的密钥。你可以按服务文档修改模型名称。'
    : '请按 API 服务文档选择协议、填写基础地址与模型名称，再填写对应密钥。');
});

for (const id of ['model-protocol', 'model-base-url', 'model-name', 'model-timeout', 'model-api-key']) {
  getField(id).addEventListener('input', () => {
    if (id === 'model-base-url' || id === 'model-protocol') getField('model-provider').value = 'custom';
    if (id !== 'model-protocol') getInput(id).setCustomValidity('');
    updateKeyHint();
    feedback('当前有未保存的修改，保存后才会用于 Agent。');
    getElement('model-clear-confirmation').hidden = true;
  });
}

getControl('model-key-toggle').addEventListener('click', () => {
  const key = getInput('model-api-key');
  const show = key.type === 'password';
  key.type = show ? 'text' : 'password';
  getControl('model-key-toggle').setAttribute('aria-pressed', String(show));
  getControl('model-key-toggle').setAttribute('aria-label', show ? '隐藏 API 密钥' : '显示 API 密钥');
  getControl('model-key-toggle').textContent = show ? '隐藏' : '显示';
});

getControl('model-clear').addEventListener('click', () => {
  if (busy || !saved?.has_api_key) return;
  getElement('model-clear-confirmation').hidden = false;
  getControl('model-clear-confirm').focus();
});
getControl('model-clear-cancel').addEventListener('click', () => {
  getElement('model-clear-confirmation').hidden = true;
  getControl('model-clear').focus();
});
getControl('model-clear-confirm').addEventListener('click', async () => {
  if (busy) return;
  let cleared = false;
  setBusy(true, '正在清除本机配置…');
  try {
    fillSaved(await request('/api/model-settings/clear', parseSettings, {}));
    feedback('本机 API 配置已清除，请重新填写并保存后进入演示。', 'success');
    showView('configuration', false, true);
    cleared = true;
  } catch (error) { feedback(readableError(error), 'error'); }
  finally { setBusy(false); if (cleared) getField('model-provider').focus(); }
});
getControl('model-reload').addEventListener('click', () => { void load(); });
getElement('model-edit-config').addEventListener('click', event => {
  event.preventDefault();
  if (busy || !saved?.configured) return;
  fillSaved(saved);
  feedback('修改本机配置后保存，会自动返回演示入口。');
  showView('configuration', true, true);
});
getControl('model-back-to-entry').addEventListener('click', () => {
  if (busy || !saved?.configured || loadFailed) return;
  fillSaved(saved);
  showView('entries', true, true);
});
window.addEventListener('hashchange', () => {
  if (busy || activeView === 'loading') return;
  const configuration = !saved?.configured || window.location.hash === '#api-configuration';
  if (!configuration && saved) fillSaved(saved);
  showView(configuration ? 'configuration' : 'entries', true);
});
getElement('model-first-run-link').addEventListener('click', event => {
  event.preventDefault();
  getField('model-provider').focus();
});
void load();
