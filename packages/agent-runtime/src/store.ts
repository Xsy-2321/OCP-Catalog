import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { FlowError } from './errors';
import { decodeSession } from './session-record';
import { bindSessionScope, type SessionStorageScope } from './session-scope';
import { SqliteSessionStore } from './sqlite-store';
import type { Session, SessionStore } from './types';

export class FileSessionStore implements SessionStore {
  private readonly backend?: SqliteSessionStore;
  constructor(private readonly directory: string) {
    // Compatibility selection occurs once. Runtime startup uses the explicit
    // factory instead; ordinary file CRUD never decides whether to migrate.
    if (existsSync(join(directory, 'sqlite-store.json')) || existsSync(join(directory, 'sessions.sqlite'))) {
      this.backend = new SqliteSessionStore(directory);
    }
  }
  async bindScope(scope: SessionStorageScope) {
    if (this.backend) return this.backend.bindScope(scope);
    const names = await readdir(this.directory).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    });
    const sessions = await Promise.all(names.filter(name => /^session_[a-f0-9-]{36}\.json$/.test(name))
      .map(async name => (await this.read(name.slice(0, -5)))!));
    await bindSessionScope(this.directory, scope, sessions);
  }
  private path(id: string) {
    if (!/^session_[a-f0-9-]{36}$/.test(id)) throw new FlowError('not_found', '找不到这个购物会话。', 404);
    return join(this.directory, `${id}.json`);
  }
  async read(id: string): Promise<Session | undefined> {
    if (this.backend) return this.backend.read(id);
    try { return decodeSession(await readFile(this.path(id), 'utf8'), id); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
  async write(session: Session) {
    if (this.backend) return this.backend.write(session);
    await mkdir(this.directory, { recursive: true });
    const destination = this.path(session.id);
    await atomicJsonWrite(destination, decodeSession(JSON.stringify(session), session.id));
  }
  async listForUser(userId: string): Promise<Session[]> {
    if (this.backend) return this.backend.listForUser(userId);
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
  /** Call outside queued operations, after producers stop adding new work. */
  async waitForIdle(): Promise<void> {
    while (this.tails.size > 0) await Promise.allSettled([...this.tails.values()]);
  }
  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(key) ?? Promise.resolve();
    const task = prior.catch(() => undefined).then(operation);
    this.tails.set(key, task);
    try { return await task; }
    finally { if (this.tails.get(key) === task) this.tails.delete(key); }
  }
}
