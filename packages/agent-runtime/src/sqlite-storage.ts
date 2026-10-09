import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SESSION_PHASES } from '@ocp-catalog/shopping-contracts';
import { decodeSession, sessionDataCorrupt } from './session-record';
import { assertSessionsMatchScope, bindSessionScope, encodeSessionScope, readSessionScope, type SessionStorageScope } from './session-scope';
import type { Session } from './types';

const schemaVersion = '2';
const unboundScope = 'unbound';
type StorageMarker = { storage: 'sqlite'; version: 2; storage_id: string; revision: number; scope: string };
export type PreparedSessionStorage = { directory: string; databasePath: string; markerPath: string; storageId: string };
type Metadata = { schema_version: string; legacy_imported: string; storage_id: string; revision: string; scope: string };

const phaseSql = SESSION_PHASES.map(phase => `'${phase}'`).join(',');
const schemaSql = `CREATE TABLE session_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    payload TEXT NOT NULL CHECK (json_valid(payload)),
    user_id TEXT GENERATED ALWAYS AS (json_extract(payload, '$.user_id')) STORED NOT NULL,
    phase TEXT GENERATED ALWAYS AS (json_extract(payload, '$.phase')) STORED NOT NULL,
    updated_at TEXT GENERATED ALWAYS AS (json_extract(payload, '$.updated_at')) STORED NOT NULL,
    pending INTEGER GENERATED ALWAYS AS
      (CASE WHEN phase IN ('checkout_pending', 'unknown') OR json_extract(payload, '$.attempt.status') = 'processing'
        THEN 1 ELSE 0 END) STORED NOT NULL,
    CHECK (COALESCE(json_type(payload, '$.id') = 'text' AND json_extract(payload, '$.id') = id, 0)),
    CHECK (COALESCE(json_type(payload, '$.user_id') = 'text' AND length(user_id) > 0, 0)),
    CHECK (COALESCE(json_type(payload, '$.phase') = 'text' AND phase IN (${phaseSql}), 0)),
    CHECK (json_type(payload, '$.attempt') IS NULL OR COALESCE(
      json_type(payload, '$.attempt') = 'object'
      AND json_type(payload, '$.attempt.status') = 'text'
      AND json_extract(payload, '$.attempt.status') IN ('processing','confirmed','failed')
      AND json_type(payload, '$.attempt.purchase_attempt_id') = 'text'
      AND length(json_extract(payload, '$.attempt.purchase_attempt_id')) > 0
      AND json_type(payload, '$.attempt.idempotency_key') = 'text'
      AND length(json_extract(payload, '$.attempt.idempotency_key')) > 0, 0))
  );
  CREATE INDEX sessions_user_updated ON sessions(user_id, updated_at DESC, id);
  CREATE INDEX sessions_user_pending ON sessions(user_id, pending, updated_at DESC, id);`;

function markerFromMetadata(meta: Metadata): StorageMarker {
  return { storage: 'sqlite', version: 2, storage_id: meta.storage_id, revision: Number(meta.revision), scope: meta.scope };
}

function readMarker(markerPath: string): StorageMarker {
  try {
    const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as StorageMarker;
    if (marker.storage !== 'sqlite' || marker.version !== 2 || typeof marker.storage_id !== 'string'
      || !/^[a-f0-9-]{36}$/.test(marker.storage_id) || !Number.isSafeInteger(marker.revision) || marker.revision < 0
      || typeof marker.scope !== 'string' || !marker.scope) sessionDataCorrupt();
    return marker;
  } catch { return sessionDataCorrupt(); }
}

// Persist the identity/revision independently of SQLite. A stale same-store
// backup must not resurrect earlier JSON or omit a later purchase attempt.
function writeMarker(markerPath: string, marker: StorageMarker): void {
  const temporary = `${markerPath}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(marker)}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, markerPath);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function openExisting(databasePath: string): Database {
  try {
    if (!existsSync(databasePath) || statSync(databasePath).size === 0) sessionDataCorrupt();
    return new Database(databasePath, { create: false, strict: true });
  } catch { return sessionDataCorrupt(); }
}

function validateStructure(db: Database): void {
    const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
    if (!tables.includes('sessions') || !tables.includes('session_meta')) sessionDataCorrupt();
    const columns = db.query<{ name: string; hidden: number }, []>("PRAGMA table_xinfo('sessions')").all();
    for (const name of ['id', 'payload', 'user_id', 'phase', 'updated_at', 'pending']) {
      const column = columns.find(value => value.name === name);
      if (!column || (['user_id', 'phase', 'updated_at', 'pending'].includes(name) && column.hidden !== 3)) sessionDataCorrupt();
    }
    const indexes = db.query<{ name: string }, []>("PRAGMA index_list('sessions')").all().map(row => row.name);
    if (!indexes.includes('sessions_user_updated') || !indexes.includes('sessions_user_pending')) sessionDataCorrupt();
}

function readMetadata(db: Database): Metadata {
  return Object.fromEntries(db.query<{ key: string; value: string }, []>('SELECT key,value FROM session_meta').all().map(row => [row.key, row.value])) as Metadata;
}

function validateDatabase(db: Database): Metadata {
  try {
    validateStructure(db);
    const meta = readMetadata(db);
    if (meta.schema_version !== schemaVersion || meta.legacy_imported !== '1'
      || typeof meta.storage_id !== 'string' || !/^[a-f0-9-]{36}$/.test(meta.storage_id)
      || typeof meta.scope !== 'string' || !meta.scope || !/^\d+$/.test(meta.revision)
      || !Number.isSafeInteger(Number(meta.revision))) sessionDataCorrupt();
    if (meta.scope !== unboundScope) {
      const scope = JSON.parse(meta.scope) as SessionStorageScope;
      if (encodeSessionScope(scope) !== meta.scope) sessionDataCorrupt();
    }
    return meta;
  } catch { return sessionDataCorrupt(); }
}

/** v1 had no external identity/revision anchor. Preserve valid history while
 * refusing to invent its missing schema/import/scope facts. Identity protection
 * starts after this explicit, fully validated upgrade, not before it.
 */
async function upgradeVersionOne(db: Database, markerPath: string,
  scope: SessionStorageScope | undefined, existingScope: SessionStorageScope | undefined): Promise<void> {
  try {
    validateStructure(db);
    const old = readMetadata(db);
    if (old.schema_version !== '1') return;
    if (old.legacy_imported !== '1') sessionDataCorrupt();
    if (existsSync(markerPath)) {
      const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
      if (marker.storage !== 'sqlite' || marker.version !== 1) sessionDataCorrupt();
    }
    const records = allStoredSessions(db);
    const binding = scope ?? existingScope;
    let encodedScope = unboundScope;
    if (old.scope && old.scope !== unboundScope) {
      const storedScope = JSON.parse(old.scope) as SessionStorageScope;
      encodedScope = encodeSessionScope(storedScope);
      if (encodedScope !== old.scope || !existingScope || encodeSessionScope(existingScope) !== encodedScope) sessionDataCorrupt();
      if (scope && encodeSessionScope(scope) !== encodedScope) throw new Error('购物数据目录属于不同模式、来源或商户；请选择独立目录或恢复原配置。');
      assertSessionsMatchScope(records, storedScope);
    } else if (binding) {
      // Missing scope is compatible only with the old explicitly unbound
      // direct-store API. A scoped runtime may not fill in missing metadata.
      sessionDataCorrupt();
    }
    db.transaction(() => {
      db.exec(`ALTER TABLE sessions RENAME TO sessions_version_one;
        DROP INDEX sessions_user_updated;
        DROP INDEX sessions_user_pending;`);
      db.exec(schemaSql.slice(schemaSql.indexOf('CREATE TABLE sessions')));
      const insertRecord = db.query('INSERT INTO sessions(id,payload) VALUES (?,?)');
      for (const record of records) insertRecord.run(record.id, JSON.stringify(record));
      db.exec('DROP TABLE sessions_version_one;');
      db.query("UPDATE session_meta SET value='2' WHERE key='schema_version'").run();
      const insert = db.query('INSERT INTO session_meta(key,value) VALUES (?,?)');
      insert.run('storage_id', crypto.randomUUID());
      insert.run('revision', '0');
      if (!old.scope) insert.run('scope', encodedScope);
    }).immediate();
    writeMarker(markerPath, markerFromMetadata(validateDatabase(db)));
  } catch (error) {
    if (error instanceof Error && error.message.includes('不同模式')) throw error;
    return sessionDataCorrupt();
  }
}

function assertMarkerMatches(marker: StorageMarker, meta: Metadata): void {
  if (marker.storage_id !== meta.storage_id || marker.revision !== Number(meta.revision) || marker.scope !== meta.scope) sessionDataCorrupt();
}

export function openPreparedSessionDatabase(prepared: PreparedSessionStorage): Database {
  const marker = readMarker(prepared.markerPath);
  if (marker.storage_id !== prepared.storageId) sessionDataCorrupt();
  const db = openExisting(prepared.databasePath);
  try {
    assertMarkerMatches(marker, validateDatabase(db));
    db.exec('PRAGMA busy_timeout = 5000;');
    return db;
  } catch (error) { db.close(); throw error; }
}

export function allStoredSessions(db: Database): Session[] {
  return db.query<{ id: string; payload: string }, []>('SELECT id,payload FROM sessions').all().map(row => decodeSession(row.payload, row.id));
}

export function commitStorageMutation(prepared: PreparedSessionStorage, db: Database, operation: () => void): void {
  db.transaction(() => {
    // Check again inside the write lock, so a competing process cannot replace
    // the marker/database between the initial read and this transaction.
    assertMarkerMatches(readMarker(prepared.markerPath), validateDatabase(db));
    operation();
    const revision = Number(validateDatabase(db).revision) + 1;
    if (!Number.isSafeInteger(revision)) sessionDataCorrupt();
    db.query("UPDATE session_meta SET value=? WHERE key='revision'").run(String(revision));
  }).immediate();
  writeMarker(prepared.markerPath, markerFromMetadata(validateDatabase(db)));
}

export async function prepareSqliteSessionStorage(directory: string, scope?: SessionStorageScope): Promise<PreparedSessionStorage> {
  await mkdir(directory, { recursive: true });
  const databasePath = join(directory, 'sessions.sqlite');
  const markerPath = join(directory, 'sqlite-store.json');
  let existingScope = await readSessionScope(directory);
  if (scope && existingScope && encodeSessionScope(existingScope) !== encodeSessionScope(scope)) {
    throw new Error('购物数据目录属于不同模式、来源或商户；请选择独立目录或恢复原配置。');
  }

  if (!existsSync(databasePath)) {
    if (existsSync(markerPath)) sessionDataCorrupt();
    const names = (await readdir(directory)).filter(name => /^session_[a-f0-9-]{36}\.json$/.test(name));
    const records = await Promise.all(names.map(async name => decodeSession(await readFile(join(directory, name), 'utf8'), name.slice(0, -5))));
    const binding = scope ?? existingScope;
    if (binding) {
      await bindSessionScope(directory, binding, records);
      existingScope = binding;
    }
    const db = new Database(databasePath, { create: true, strict: true });
    try {
      chmodSync(databasePath, 0o600);
      db.transaction(() => {
        db.exec(schemaSql);
        const meta: Metadata = { schema_version: schemaVersion, legacy_imported: '1', storage_id: crypto.randomUUID(), revision: '0', scope: binding ? encodeSessionScope(binding) : unboundScope };
        const insertMeta = db.query('INSERT INTO session_meta(key,value) VALUES (?,?)');
        for (const [key, value] of Object.entries(meta)) insertMeta.run(key, value);
        const insert = db.query('INSERT INTO sessions(id,payload) VALUES (?,?)');
        for (const record of records) insert.run(record.id, JSON.stringify(record));
      }).immediate();
      writeMarker(markerPath, markerFromMetadata(validateDatabase(db)));
    } finally { db.close(); }
  }

  // This external anchor is part of an established store, not a recoverable
  // cache. Even a complete DB cannot prove its history after the anchor is lost.
  if (!existsSync(markerPath)) sessionDataCorrupt();

  // Once a database exists it is never initialized, repaired, or imported.
  // No CREATE statements execute before verifying an existing database.
  const db = openExisting(databasePath);
  let meta: Metadata;
  try {
    await upgradeVersionOne(db, markerPath, scope, existingScope);
    meta = validateDatabase(db);
    assertMarkerMatches(readMarker(markerPath), meta);
    const records = allStoredSessions(db);
    const binding = scope ?? existingScope;
    if (meta.scope !== unboundScope) {
      if (!existingScope || encodeSessionScope(existingScope) !== meta.scope) sessionDataCorrupt();
      if (scope && encodeSessionScope(scope) !== meta.scope) throw new Error('购物数据目录属于不同模式、来源或商户；请选择独立目录或恢复原配置。');
      assertSessionsMatchScope(records, JSON.parse(meta.scope));
    } else if (binding) {
      await bindSessionScope(directory, binding, records);
      const prepared = { directory, databasePath, markerPath, storageId: meta.storage_id };
      commitStorageMutation(prepared, db, () => db.query("UPDATE session_meta SET value=? WHERE key='scope'").run(encodeSessionScope(binding)));
      meta = validateDatabase(db);
    }
  } finally { db.close(); }
  return { directory, databasePath, markerPath, storageId: meta.storage_id };
}

export async function bindPreparedSessionScope(prepared: PreparedSessionStorage, scope: SessionStorageScope): Promise<void> {
  const db = openPreparedSessionDatabase(prepared);
  try {
    const meta = validateDatabase(db);
    const encoded = encodeSessionScope(scope);
    if (meta.scope !== unboundScope && meta.scope !== encoded) throw new Error('购物数据目录属于不同模式、来源或商户；请选择独立目录或恢复原配置。');
    await bindSessionScope(prepared.directory, scope, allStoredSessions(db));
    if (meta.scope === encoded) return;
    commitStorageMutation(prepared, db, () => db.query("UPDATE session_meta SET value=? WHERE key='scope'").run(encoded));
  } finally { db.close(); }
}
