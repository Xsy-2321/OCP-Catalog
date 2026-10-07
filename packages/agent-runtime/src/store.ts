import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FlowError } from './errors';
import type { Session, SessionStore } from './types';

export class FileSessionStore implements SessionStore {
  constructor(private readonly directory: string) {}
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
