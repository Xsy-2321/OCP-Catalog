import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Session } from './types';

export type SessionStorageScope = {
  mode: 'mock' | 'http';
  origin: string;
  merchant_id: string;
  catalog_id: string;
};

export function encodeSessionScope(scope: SessionStorageScope): string {
  if (!['mock', 'http'].includes(scope.mode) || new URL(scope.origin).origin !== scope.origin
    || !scope.merchant_id || !scope.catalog_id) throw new Error('购物存储来源配置无效。');
  return JSON.stringify({ mode: scope.mode, origin: scope.origin, merchant_id: scope.merchant_id, catalog_id: scope.catalog_id });
}

export async function readSessionScope(directory: string): Promise<SessionStorageScope | undefined> {
  try {
    const value = JSON.parse(await readFile(join(directory, 'runtime-scope.json'), 'utf8')) as SessionStorageScope;
    encodeSessionScope(value);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export function assertSessionsMatchScope(sessions: Session[], scope: SessionStorageScope): void {
  for (const session of sessions) {
    if (session.mode !== scope.mode || session.intent.merchant_id !== scope.merchant_id
      || (session.quote?.catalog_id && session.quote.catalog_id !== scope.catalog_id)
      || (session.checkout_url && new URL(session.checkout_url).origin !== scope.origin)) {
      throw new Error('原购物会话与当前商户配置不一致；请选择独立数据目录。');
    }
  }
}

export async function bindSessionScope(directory: string, scope: SessionStorageScope, sessions: Session[]): Promise<void> {
  const text = encodeSessionScope(scope);
  const existing = await readSessionScope(directory);
  if (existing && encodeSessionScope(existing) !== text) {
    throw new Error('购物数据目录属于不同模式、来源或商户；请选择独立目录或恢复原配置。');
  }
  assertSessionsMatchScope(sessions, scope);
  if (existing) return;
  await mkdir(directory, { recursive: true });
  try { await writeFile(join(directory, 'runtime-scope.json'), text, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const raced = await readSessionScope(directory);
    if (!raced || encodeSessionScope(raced) !== text) throw new Error('购物数据目录已由不同来源配置绑定。');
  }
}
