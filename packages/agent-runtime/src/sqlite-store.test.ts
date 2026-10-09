import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SESSION_PHASES, isPendingPurchase } from '@ocp-catalog/shopping-contracts';
import { copyFile, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShoppingCoordinator } from './coordinator';
import { LocalMockIssuer } from './authorization';
import { MOCK_ORIGIN, MockMerchantTransport } from './mock-transport';
import { SqliteSessionStore } from './sqlite-store';
import { FileSessionStore } from './store';
import type { Session } from './types';
import { normalizeStoredSession } from './basket-model';
import { createSessionStore } from './session-store-factory';

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'ocp-sqlite-store-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
const scope = { mode: 'mock' as const, origin: MOCK_ORIGIN, merchant_id: 'coffee-demo', catalog_id: 'mock_coffee_catalog' };
function session(userId = 'user-a', phase: Session['phase'] = 'new'): Session {
  return normalizeStoredSession({ id: `session_${crypto.randomUUID()}`, user_id: userId, mode: 'mock', phase,
    intent: { query: '咖啡', items: [{ query: '咖啡', quantity: 1 }], merchant_id: 'coffee-demo', quantity: 1, currency: 'CNY', max_total_minor: 3000, fulfillment: 'pickup' },
    candidates: [], revision: 0, created_at: '2026-10-08T00:00:00Z', updated_at: '2026-10-08T00:00:00Z' });
}
test('atomically imports legacy JSON, retains snapshots and does not replay stale snapshots on restart', async () => {
  const original = session('user-a', 'unknown');
  const path = join(directory, `${original.id}.json`), text = JSON.stringify(original);
  await writeFile(path, text);
  const store = new SqliteSessionStore(directory); await store.bindScope(scope);
  expect(await store.listPendingForUser('user-a')).toEqual([original]);
  await store.write({ ...original, phase: 'confirmed', revision: 1 });
  expect((await new SqliteSessionStore(directory).read(original.id))!.phase).toBe('confirmed');
  expect((await new FileSessionStore(directory).read(original.id))!.phase).toBe('confirmed');
  expect(await readFile(path, 'utf8')).toBe(text);
});
test('a malformed legacy record aborts all migration and prevents starting a new purchase', async () => {
  const valid = session();
  await writeFile(join(directory, `${valid.id}.json`), JSON.stringify(valid));
  await writeFile(join(directory, `session_${crypto.randomUUID()}.json`), '{broken');
  await expect(new SqliteSessionStore(directory).bindScope(scope)).rejects.toMatchObject({ code: 'session_data_corrupt' });
  expect(existsSync(join(directory, 'sessions.sqlite'))).toBe(false);
});
test('user and pending queries use indexes and preserve unknown or processing attempts', async () => {
  const store = new SqliteSessionStore(directory); await store.bindScope(scope);
  const unknown = session('user-a', 'unknown'), processing = session('user-a', 'awaiting_confirmation');
  processing.attempt = { status: 'processing', purchase_attempt_id: 'attempt-one', idempotency_key: 'key-one' };
  for (const value of [unknown, processing, session('user-a', 'confirmed'), session('user-b', 'unknown')]) await store.write(value);
  expect((await store.listPendingForUser('user-a')).map(value => value.id).sort()).toEqual([unknown.id, processing.id].sort());
  expect(await store.listForUser('user-b')).toHaveLength(1);
  const db = new Database(join(directory, 'sessions.sqlite'));
  try {
    const plan = db.query<{ detail: string }, [string]>('EXPLAIN QUERY PLAN SELECT payload FROM sessions WHERE user_id=? AND pending=1 ORDER BY updated_at DESC,id').all('user-a');
    expect(plan.map(row => row.detail).join(' ')).toContain('sessions_user_pending');
  } finally { db.close(); }
  const issuer = new LocalMockIssuer();
  const coordinator = new ShoppingCoordinator(new MockMerchantTransport(join(directory, 'mock'), issuer.publicKey), store, issuer, MOCK_ORIGIN);
  await expect(coordinator.create('user-a', unknown.intent)).rejects.toMatchObject({ code: 'unresolved_purchase' });
});
test('a damaged stored pending record fails closed rather than being ignored', async () => {
  const store = new SqliteSessionStore(directory), pending = session('user-a', 'unknown');
  await store.write(pending);
  const db = new Database(join(directory, 'sessions.sqlite'));
  try { db.query('UPDATE sessions SET payload=? WHERE id=?').run(JSON.stringify({ ...pending, intent: null }), pending.id); }
  finally { db.close(); }
  await expect(store.listPendingForUser('user-a')).rejects.toMatchObject({ code: 'session_data_corrupt' });
});
test('database constraints prevent invalid phases, owners or attempts from disappearing from the pending index', async () => {
  const store = new SqliteSessionStore(directory), pending = session('user-a', 'unknown');
  await store.write(pending);
  const db = new Database(join(directory, 'sessions.sqlite'));
  try {
    for (const mutation of [{ phase: 'unknow' }, { user_id: 123 }, { attempt: {} },
      { attempt: null }, { attempt: { status: 'done', purchase_attempt_id: 'a', idempotency_key: 'k' } }]) {
      expect(() => db.query('UPDATE sessions SET payload=? WHERE id=?')
        .run(JSON.stringify({ ...pending, ...mutation }), pending.id)).toThrow();
    }
  } finally { db.close(); }
  expect(await store.listPendingForUser('user-a')).toEqual([pending]);
});
test('scope changes and a missing migrated database are refused', async () => {
  const store = new SqliteSessionStore(directory); await store.bindScope(scope);
  await expect(new SqliteSessionStore(directory).bindScope({ ...scope, origin: 'http://other.example' })).rejects.toThrow('不同');
  await unlink(join(directory, 'sessions.sqlite'));
  await expect(new SqliteSessionStore(directory).listPendingForUser('user-a')).rejects.toMatchObject({ code: 'session_data_corrupt' });
});
test('a complete v1 SQLite store is upgraded without replaying a stale JSON snapshot', async () => {
  const pending = session('user-a', 'unknown');
  const db = new Database(join(directory, 'sessions.sqlite'));
  db.exec(`CREATE TABLE session_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT INTO session_meta VALUES ('legacy_imported','1'), ('schema_version','1');
    CREATE TABLE sessions(id TEXT PRIMARY KEY,payload TEXT NOT NULL,
      user_id TEXT GENERATED ALWAYS AS (json_extract(payload,'$.user_id')) STORED,
      phase TEXT GENERATED ALWAYS AS (json_extract(payload,'$.phase')) STORED,
      updated_at TEXT GENERATED ALWAYS AS (json_extract(payload,'$.updated_at')) STORED,
      pending INTEGER GENERATED ALWAYS AS (CASE WHEN phase='unknown' THEN 1 ELSE 0 END) STORED);
    CREATE INDEX sessions_user_pending ON sessions(user_id,pending,updated_at DESC,id);
    CREATE INDEX sessions_user_updated ON sessions(user_id,updated_at DESC,id);`);
  db.query('INSERT INTO sessions(id,payload) VALUES (?,?)').run(pending.id, JSON.stringify(pending)); db.close();
  await writeFile(join(directory, 'sqlite-store.json'), '{"storage":"sqlite","version":1}');
  await writeFile(join(directory, `${pending.id}.json`), JSON.stringify({ ...pending, phase: 'confirmed' }));
  const store = new SqliteSessionStore(directory);
  expect(await store.listPendingForUser('user-a')).toEqual([pending]);
  const upgraded = new Database(join(directory, 'sessions.sqlite'));
  try {
    expect(upgraded.query<{ value: string }, []>("SELECT value FROM session_meta WHERE key='schema_version'").get()!.value).toBe('2');
  } finally { upgraded.close(); }
});

test('startup refuses a truncated, empty SQLite or foreign database and never imports stale snapshots', async () => {
  for (const replacement of ['truncated', 'empty-sqlite', 'foreign'] as const) {
    const target = join(directory, replacement);
    const store = await createSessionStore(target, scope);
    const pending = session('user-a', 'unknown');
    await store.write(pending);
    await writeFile(join(target, `${pending.id}.json`), JSON.stringify({ ...pending, phase: 'new' }));
    const databasePath = join(target, 'sessions.sqlite');
    if (replacement === 'truncated') await writeFile(databasePath, '');
    else if (replacement === 'empty-sqlite') {
      await unlink(databasePath);
      const db = new Database(databasePath);
      db.exec('CREATE TABLE unrelated(value TEXT)');
      db.close();
    } else {
      const foreign = join(directory, 'foreign-source');
      await createSessionStore(foreign, scope);
      await copyFile(join(foreign, 'sessions.sqlite'), databasePath);
    }
    await expect(createSessionStore(target, scope)).rejects.toMatchObject({ code: 'session_data_corrupt' });
    await expect(store.listPendingForUser!('user-a')).rejects.toMatchObject({ code: 'session_data_corrupt' });
  }
});

test('each required metadata fact is checked before any recovery or legacy import', async () => {
  for (const key of ['schema_version', 'legacy_imported', 'storage_id', 'revision', 'scope']) {
    const target = join(directory, key);
    const store = await createSessionStore(target, scope);
    const pending = session('user-a', 'unknown');
    await store.write(pending);
    await writeFile(join(target, `${pending.id}.json`), JSON.stringify({ ...pending, phase: 'new' }));
    const db = new Database(join(target, 'sessions.sqlite'));
    try { db.query('DELETE FROM session_meta WHERE key=?').run(key); } finally { db.close(); }
    await expect(createSessionStore(target, scope)).rejects.toMatchObject({ code: 'session_data_corrupt' });
  }
});

test('an old same-store database snapshot cannot omit a newly persisted purchase attempt', async () => {
  const store = await createSessionStore(directory, scope);
  const snapshot = join(directory, 'snapshot.sqlite');
  await copyFile(join(directory, 'sessions.sqlite'), snapshot);
  await store.write(session('user-a', 'unknown'));
  await copyFile(snapshot, join(directory, 'sessions.sqlite'));
  await expect(createSessionStore(directory, scope)).rejects.toMatchObject({ code: 'session_data_corrupt' });
});

test('a crash between database commit and marker replacement fails closed without rewriting either side', async () => {
  const store = await createSessionStore(directory, scope);
  const pending = session('user-a', 'unknown');
  await store.write(pending);
  const markerPath = join(directory, 'sqlite-store.json');
  const markerBefore = await readFile(markerPath, 'utf8');
  const db = new Database(join(directory, 'sessions.sqlite'));
  let committedRevision: string;
  try {
    db.query("UPDATE session_meta SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT) WHERE key='revision'").run();
    committedRevision = db.query<{ value: string }, []>("SELECT value FROM session_meta WHERE key='revision'").get()!.value;
  } finally { db.close(); }
  await expect(createSessionStore(directory, scope)).rejects.toMatchObject({ code: 'session_data_corrupt' });
  expect(await readFile(markerPath, 'utf8')).toBe(markerBefore);
  const preserved = new Database(join(directory, 'sessions.sqlite'));
  try {
    expect(preserved.query<{ value: string }, []>("SELECT value FROM session_meta WHERE key='revision'").get()!.value).toBe(committedRevision);
    expect(JSON.parse(preserved.query<{ payload: string }, [string]>('SELECT payload FROM sessions WHERE id=?').get(pending.id)!.payload).phase).toBe('unknown');
  } finally { preserved.close(); }
});

test('an established database cannot recreate a missing external identity marker', async () => {
  const store = await createSessionStore(directory, scope);
  await store.write(session('user-a', 'unknown'));
  await unlink(join(directory, 'sqlite-store.json'));
  await expect(createSessionStore(directory, scope)).rejects.toMatchObject({ code: 'session_data_corrupt' });
  expect(existsSync(join(directory, 'sqlite-store.json'))).toBe(false);
});

test('the SQL pending index agrees with the shared purchase rule for every phase and attempt state', async () => {
  const store = await createSessionStore(directory, scope);
  const samples: Session[] = [];
  for (const phase of SESSION_PHASES) {
    for (const status of [undefined, 'processing', 'confirmed', 'failed'] as const) {
      const value = session('matrix-user', phase);
      if (status) value.attempt = { status, purchase_attempt_id: `attempt-${value.id}`, idempotency_key: `key-${value.id}` };
      samples.push(value);
      await store.write(value);
    }
  }
  expect((await store.listPendingForUser!('matrix-user')).map(value => value.id).sort())
    .toEqual(samples.filter(isPendingPurchase).map(value => value.id).sort());
});

test('lost-response recovery refuses damaged storage before a second payment is possible', async () => {
  const issuer = new LocalMockIssuer();
  const merchant = new MockMerchantTransport(join(directory, 'mock'), issuer.publicKey, { fault: 'response_lost' });
  const target = join(directory, 'sessions');
  const coordinator = new ShoppingCoordinator(merchant, await createSessionStore(target, scope), issuer, MOCK_ORIGIN);
  const created = await coordinator.create('user-a', session().intent);
  await coordinator.search('user-a', created.id);
  const quoted = await coordinator.select('user-a', created.id, 'mock_latte');
  const unknown = await coordinator.confirm('user-a', created.id, { quote_id: quoted.quote!.quote_id, terms_hash: quoted.quote!.terms_hash, revision: quoted.revision });
  expect(unknown.phase).toBe('unknown');
  const merchantPath = join(directory, 'mock', 'mock-transport.json');
  expect(JSON.parse(await readFile(merchantPath, 'utf8')).payment_count).toBe(1);
  await writeFile(join(target, 'sessions.sqlite'), '');
  await expect(createSessionStore(target, scope)).rejects.toMatchObject({ code: 'session_data_corrupt' });
  expect(JSON.parse(await readFile(merchantPath, 'utf8')).payment_count).toBe(1);
});
