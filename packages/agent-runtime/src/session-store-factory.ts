import { SqliteSessionStore } from './sqlite-store';
import type { SessionStorageScope } from './session-scope';
import type { SessionStore } from './types';

/** The runtime's only backend-selection/startup boundary. A successful return
 * guarantees migration, storage identity and merchant scope were validated.
 */
export async function createSessionStore(directory: string, scope: SessionStorageScope): Promise<SessionStore> {
  const store = new SqliteSessionStore(directory, scope);
  await store.prepare();
  return store;
}
