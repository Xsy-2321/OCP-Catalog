import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join, parse, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FlowError, ShoppingModelClient, type ShoppingModelProtocol } from '@ocp-catalog/agent-runtime';

const TIMEOUT = 30_000;
const MAX_BYTES = 8192;
const LOCK_WAIT_MS = 2000;
const protocols = ['openai', 'anthropic', 'gemini'] as const;
const fields = ['protocol', 'base_url', 'model', 'api_key', 'timeout_ms'];
type StoredSettings = { version: 1; protocol: ShoppingModelProtocol; base_url: string; model: string; api_key: string; timeout_ms: number };
export interface LocalModelSettingsView {
  configured: boolean; protocol: ShoppingModelProtocol; base_url: string; model: string;
  timeout_ms: number; has_api_key: boolean; source: 'local' | 'none';
}
export interface LocalModelSettings {
  view(): LocalModelSettingsView;
  getModel(): ShoppingModelClient | undefined;
  save(input: unknown): Promise<LocalModelSettingsView>;
  test(input: unknown): Promise<{ ok: true; message: string }>;
  clear(): Promise<LocalModelSettingsView>;
}
function invalid(message: string): never { throw new FlowError('invalid_model_settings', message); }
function persistenceError(): FlowError {
  return new FlowError('model_settings_unavailable', '本机模型配置文件无法安全读写，请检查文件及目录权限。', 503);
}
function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT'; }

/** Reject symlink files and directory ancestors before reading or changing a private key. */
function inspectPath(path: string): void {
  const root = parse(path).root;
  let current = root;
  for (const part of path.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      const info = lstatSync(current);
      if (info.isSymbolicLink() || (current === path ? !info.isFile() : !info.isDirectory())) throw persistenceError();
    } catch (error) { if (isMissing(error)) return; throw error; }
  }
}
function readInput(input: unknown, existing?: StoredSettings): StoredSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('请填写模型连接配置。');
  const values = input as Record<string, unknown>;
  if (Object.keys(values).some(field => !fields.includes(field))) invalid('模型配置包含不支持的字段。');
  if (typeof values.protocol !== 'string' || !protocols.includes(values.protocol as ShoppingModelProtocol)) invalid('请选择 OpenAI 兼容、Anthropic 或 Gemini 协议。');
  const protocol = values.protocol as ShoppingModelProtocol;
  if (typeof values.base_url !== 'string' || !values.base_url.trim() || values.base_url.length > 2048) invalid('请填写不超过 2048 字符的 API 基础地址。');
  let base: URL;
  try { base = new URL(values.base_url.trim()); } catch { invalid('API 基础地址无效。'); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname);
  if ((base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback)) || base.username || base.password || base.search || base.hash) {
    invalid('API 基础地址须使用 HTTPS，或本机 HTTP 地址，且不能包含密钥、账号、查询参数或片段。');
  }
  const base_url = base.href.replace(/\/+$/, '');
  if (base_url.length > 2048) invalid('规范化后的 API 基础地址不能超过 2048 个字符，请缩短地址。');
  if (typeof values.model !== 'string' || !/^[a-zA-Z0-9._:/-]{1,128}$/.test(values.model.trim())) invalid('模型名称须为 1–128 个字母、数字或 . _ : / - 字符。');
  const model = values.model.trim();
  const timeout_ms = values.timeout_ms ?? TIMEOUT;
  if (!Number.isSafeInteger(timeout_ms) || (timeout_ms as number) < 100 || (timeout_ms as number) > 60_000) invalid('单次请求超时须为 100–60000 毫秒的整数。');
  if (values.api_key !== undefined && typeof values.api_key !== 'string') invalid('API Key 须为文本。');
  const supplied = typeof values.api_key === 'string' ? values.api_key.trim() : '';
  const sameEndpoint = existing?.protocol === protocol && existing.base_url === base_url;
  const api_key = supplied || (sameEndpoint ? existing!.api_key : '');
  if (!api_key) invalid('请填写 API Key；更改协议或 API 地址时须重新填写。');
  if (api_key.length > 4096 || /[^\x21-\x7e]/.test(api_key)) invalid('API Key 过长或包含不支持的字符。');
  const next: StoredSettings = { version: 1, protocol, base_url, model, api_key, timeout_ms: timeout_ms as number };
  if (Buffer.byteLength(JSON.stringify(next), 'utf8') > MAX_BYTES) invalid('模型配置保存内容不能超过 8192 字节，请缩短地址或 API Key。');
  return next;
}

function publicView(stored?: StoredSettings): LocalModelSettingsView {
  return stored ? { configured: true, protocol: stored.protocol, base_url: stored.base_url, model: stored.model,
    timeout_ms: stored.timeout_ms, has_api_key: true, source: 'local' }
    : { configured: false, protocol: 'openai', base_url: '', model: '', timeout_ms: TIMEOUT, has_api_key: false, source: 'none' };
}

/** Disk is authoritative across local instances; keys and clients are request snapshots only. */
export async function createLocalModelSettings(filename: string, options: { fetch?: typeof globalThis.fetch } = {}): Promise<LocalModelSettings> {
  const path = resolve(filename);
  let changes: Promise<void> = Promise.resolve();
  const client = (value: StoredSettings) => new ShoppingModelClient({ protocol: value.protocol,
    baseUrl: value.base_url, model: value.model, apiKey: value.api_key, timeoutMs: value.timeout_ms, fetch: options.fetch });
  function readCurrent(): { stored: StoredSettings; model: ShoppingModelClient } | undefined {
    let descriptor: number | undefined;
    try {
      inspectPath(path);
      descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const metadata = fstatSync(descriptor);
      if (!metadata.isFile() || metadata.size > MAX_BYTES) throw persistenceError();
      // Bound the actual read too, including an unexpected append after stat.
      const bytes = Buffer.alloc(MAX_BYTES + 1);
      let size = 0;
      while (size < bytes.length) {
        const count = readSync(descriptor, bytes, size, bytes.length - size, null);
        if (!count) break;
        size += count;
      }
      if (size > MAX_BYTES) throw persistenceError();
      const value: unknown = JSON.parse(bytes.subarray(0, size).toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw persistenceError();
      const { version, ...input } = value as Record<string, unknown>;
      if (version !== 1) throw persistenceError();
      const stored = readInput(input);
      return { stored, model: client(stored) };
    } catch (error) { if (isMissing(error)) return undefined; throw persistenceError(); }
    finally { if (descriptor !== undefined) closeSync(descriptor); }
  }
  // Preserve startup's fail-closed validation, without retaining credentials.
  readCurrent();
  async function replaceFile(temp: string): Promise<void> {
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (true) {
      inspectPath(temp); inspectPath(path);
      try { await rename(temp, path); return; }
      catch (error) {
        // Windows can deny an atomic replacement while another instance briefly
        // holds a read descriptor. Keep the write lock and retry that replacement;
        // never delete the original file or bypass permanent permission errors.
        if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM'
          || Date.now() >= deadline) throw error;
        await new Promise<void>(done => setTimeout(done, 20));
      }
    }
  }
  async function withWriteLock<T>(action: () => Promise<T>): Promise<T> {
    const lockPath = `${path}.lock`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      inspectPath(path);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const deadline = Date.now() + LOCK_WAIT_MS;
      while (!handle) {
        inspectPath(path); inspectPath(lockPath);
        try { handle = await open(lockPath, 'wx', 0o600); }
        catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          const existing = code === 'EEXIST';
          // Windows may report EPERM while a previous owner finishes deleting
          // its lock. Retry creating it; do not remove or take over that lock.
          if (!existing && !(process.platform === 'win32' && code === 'EPERM')) throw error;
          // Never steal a lock based on time or PID; a crashed writer requires
          // its owner to confirm exit and remove only this private lock file.
          if (Date.now() >= deadline) {
            if (!existing) throw error;
            throw new FlowError('model_settings_busy', '模型配置正由其他进程修改；请稍后重试。若进程已异常退出，请确认退出后清理 settings.json.lock。', 409);
          }
          await new Promise<void>(done => setTimeout(done, 20));
        }
      }
    } catch (error) { if (error instanceof FlowError) throw error; throw persistenceError(); }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }), 'utf8');
      await handle.sync();
      return await action();
    }
    finally {
      try { await handle.close(); await unlink(lockPath); }
      catch { throw persistenceError(); }
    }
  }
  function serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = changes.then(action);
    changes = result.then(() => undefined, () => undefined);
    return result;
  }
  return {
    view: () => publicView(readCurrent()?.stored), getModel: () => readCurrent()?.model,
    save(input) {
      return serialize(() => withWriteLock(async () => {
        // Refresh within the cross-process lock: blank keys cannot resurrect
        // credentials removed or replaced by a different server instance.
        const next = readInput(input, readCurrent()?.stored);
        client(next);
        const temp = `${path}.${randomUUID()}.tmp`;
        let created = false;
        try {
          inspectPath(path);
          const handle = await open(temp, 'wx', 0o600); created = true;
          try { await handle.writeFile(JSON.stringify(next), 'utf8'); await handle.sync(); }
          finally { await handle.close(); }
          inspectPath(path);
          await replaceFile(temp); created = false;
          return publicView(next);
        } catch { throw persistenceError(); }
        finally { if (created) await unlink(temp).catch(() => undefined); }
      }));
    },
    async test(input) {
      // Refresh immediately before obtaining this request's credentials.
      // An in-flight provider request retains its starting snapshot.
      const draft = readInput(input, readCurrent()?.stored);
      const result = await client(draft).complete([
        { role: 'system', content: 'This is a connection check. Call connection_check exactly once with {"ok":true}. Do not do any other task.' },
        { role: 'user', content: 'Check function calling only.' },
      ], [{ type: 'function', function: { name: 'connection_check', description: 'Harmless local connection check; no external action.',
        parameters: { type: 'object', properties: { ok: { type: 'boolean', enum: [true] } }, required: ['ok'], additionalProperties: false } } }], 'connection_check');
      const call = result.tool_calls?.[0];
      let argumentsValue: unknown;
      try { argumentsValue = call && JSON.parse(call.function.arguments); } catch { /* fixed public error below */ }
      if (!call || call.function.name !== 'connection_check' || !argumentsValue || typeof argumentsValue !== 'object'
        || Array.isArray(argumentsValue) || Object.keys(argumentsValue).length !== 1 || (argumentsValue as Record<string, unknown>).ok !== true) {
        throw new FlowError('model_tool_call_unavailable', '模型未通过工具调用检查，请选择支持工具调用的模型并检查协议。', 502);
      }
      return { ok: true, message: '连接成功，模型已通过工具调用检查。配置尚未保存。' };
    },
    clear() {
      return serialize(() => withWriteLock(async () => {
        try { inspectPath(path); await unlink(path); }
        catch (error) { if (!isMissing(error)) throw persistenceError(); }
        return publicView();
      }));
    },
  };
}
