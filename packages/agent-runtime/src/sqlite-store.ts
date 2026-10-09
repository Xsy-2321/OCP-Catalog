import { Database } from 'bun:sqlite';
import { FlowError } from './errors';
import { decodeSession, sessionIdPattern } from './session-record';
import { bindPreparedSessionScope, commitStorageMutation, openPreparedSessionDatabase, prepareSqliteSessionStorage, type PreparedSessionStorage } from './sqlite-storage';
import type { SessionStorageScope } from './session-scope';
import type { Session, SessionStore } from './types';

/** A fixed SQLite backend. Startup/import happens once; CRUD only opens validated
 * short-lived connections so Windows cleanup never leaves database handles open.
 */
export class SqliteSessionStore implements SessionStore {
  private preparation?: Promise<PreparedSessionStorage>;
  constructor(private readonly directory: string, private readonly scope?: SessionStorageScope) {}

  async prepare(): Promise<void> {
    await this.prepared();
  }

  private prepared(): Promise<PreparedSessionStorage> {
    return this.preparation ??= prepareSqliteSessionStorage(this.directory, this.scope);
  }

  async bindScope(scope: SessionStorageScope): Promise<void> {
    this.preparation ??= prepareSqliteSessionStorage(this.directory, scope);
    await bindPreparedSessionScope(await this.preparation, scope);
  }

  private async withDatabase<T>(operation: (db: Database, prepared: PreparedSessionStorage) => T): Promise<T> {
    const prepared = await this.prepared();
    const db = openPreparedSessionDatabase(prepared);
    try { return operation(db, prepared); } finally { db.close(); }
  }

  async read(id: string): Promise<Session | undefined> {
    if (!sessionIdPattern.test(id)) throw new FlowError('not_found', '找不到这个购物会话。', 404);
    return this.withDatabase(db => {
      const row = db.query<{ payload: string }, [string]>('SELECT payload FROM sessions WHERE id=?').get(id);
      return row ? decodeSession(row.payload, id) : undefined;
    });
  }

  async write(session: Session): Promise<void> {
    const payload = JSON.stringify(decodeSession(JSON.stringify(session), session.id));
    await this.withDatabase((db, prepared) => commitStorageMutation(prepared, db, () => {
      db.query('INSERT INTO sessions(id,payload) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload')
        .run(session.id, payload);
    }));
  }

  async listForUser(userId: string): Promise<Session[]> {
    return this.list(userId, false);
  }

  async listPendingForUser(userId: string): Promise<Session[]> {
    return this.list(userId, true);
  }

  private async list(userId: string, pendingOnly: boolean): Promise<Session[]> {
    return this.withDatabase(db => db.query<{ id: string; payload: string }, [string]>(
      `SELECT id,payload FROM sessions WHERE user_id=? ${pendingOnly ? 'AND pending=1' : ''} ORDER BY updated_at DESC,id`)
      .all(userId).map(row => decodeSession(row.payload, row.id)));
  }
}
