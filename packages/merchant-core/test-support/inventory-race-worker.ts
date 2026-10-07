import { existsSync } from 'node:fs';
import { makeTestContext, authorizationFor } from '../src/test-support';
import { getStoredQuote } from '../src/quote';
import { runCheckout } from '../src/checkout';
import { CommerceError } from '@ocp-catalog/shopping-contracts';

// Explicit test-only storage and public test signing key; no production config.
const [dbPath, quoteId, attemptId, readyPath, gatePath, mode] = process.argv.slice(2);
if (!dbPath || !quoteId || !attemptId || !readyPath || !gatePath) throw new Error('missing race worker arguments');
const ctx = makeTestContext({ databasePath: dbPath });
await Bun.write(readyPath, 'ready');
const deadline = Date.now() + 10_000;
while (!existsSync(gatePath)) {
  if (Date.now() > deadline) throw new Error('race gate timed out');
  await Bun.sleep(5);
}
const stored = getStoredQuote(ctx.db, quoteId);
if (stored === null) throw new Error('missing race quote');
try {
  const result = runCheckout(ctx, {
    purchase_attempt_id: attemptId,
    quote_id: quoteId,
    terms_hash: stored.quote.terms_hash,
    authorization: authorizationFor(stored.quote, { purchaseAttemptId: attemptId }),
  }, { callerId: 'user_demo_1', idempotencyKey: `key_${attemptId}` });
  console.log(JSON.stringify({ kind: result.kind }));
  if (mode === 'wait-for-kill') await Bun.sleep(30_000);
} catch (error) {
  if (!(error instanceof CommerceError)) throw error;
  console.log(JSON.stringify({ kind: error.code }));
} finally {
  ctx.db.close();
}
