import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FlowError } from './errors';
import type { Session, SessionStore } from './types';

export class FileSessionStore implements SessionStore {
  constructor(private readonly directory: string) {}
  async bindScope(scope: { mode: 'mock' | 'http'; origin: string; merchant_id: string; catalog_id: string }) {
    await mkdir(this.directory, { recursive: true });
    const path = join(this.directory, 'runtime-scope.json');
    const text = JSON.stringify(scope);
    try {
      const existing = JSON.parse(await readFile(path, 'utf8')) as typeof scope;
      if (JSON.stringify(existing) !== text) throw new Error('购物数据目录属于不同模式、来源或商户；请选择独立目录或恢复原配置。');
      return;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    // Older data has no scope marker. Bind only when its saved identities and
    // endpoint agree; never modify an old session to fit a new backend.
    for (const name of await readdir(this.directory)) {
      if (!/^session_[a-f0-9-]{36}\.json$/.test(name)) continue;
      const session = (await this.read(name.slice(0, -5)))!;
      if (session.mode !== scope.mode || session.intent.merchant_id !== scope.merchant_id
        || (session.quote?.catalog_id && session.quote.catalog_id !== scope.catalog_id)
        || (session.checkout_url && new URL(session.checkout_url).origin !== scope.origin)) {
        throw new Error('原购物会话与当前商户配置不一致；请选择独立数据目录。');
      }
    }
    try { await writeFile(path, text, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await readFile(path, 'utf8') !== text) throw new Error('购物数据目录已由不同来源配置绑定。');
    }
  }
  private path(id: string) {
    if (!/^session_[a-f0-9-]{36}$/.test(id)) throw new FlowError('not_found', '找不到这个购物会话。', 404);
    return join(this.directory, `${id}.json`);
  }
  async read(id: string): Promise<Session | undefined> {
    try { return JSON.parse(await readFile(this.path(id), 'utf8')) as Session; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
  async write(session: Session) {
    await mkdir(this.directory, { recursive: true });
    const destination = this.path(session.id);
    await atomicJsonWrite(destination, session);
  }
  async listForUser(userId: string): Promise<Session[]> {
    let names: string[];
    try { names = await readdir(this.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const sessions = await Promise.all(names.filter(name => /^session_[a-f0-9-]{36}\.json$/.test(name))
      .map(name => this.read(name.slice(0, -5))));
    return sessions.filter((session): session is Session => session !== undefined && session.user_id === userId);
  }
}

export async function atomicJsonWrite(destination: string, value: unknown) {
  const temp = `${destination}.${crypto.randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
  await rename(temp, destination);
}

/** Serializes this local demo's mutations. Production merchant idempotency belongs to B. */
export class SerialQueue {
  private tails = new Map<string, Promise<unknown>>();
  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(key) ?? Promise.resolve();
    const task = prior.catch(() => undefined).then(operation);
    this.tails.set(key, task);
    try { return await task; }
    finally { if (this.tails.get(key) === task) this.tails.delete(key); }
  }
}
