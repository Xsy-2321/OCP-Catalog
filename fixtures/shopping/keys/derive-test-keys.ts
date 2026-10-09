/**
 * Derives the demo's Ed25519 keypair from a fixed seed.
 *
 * ============================ TEST KEY — NOT A SECRET =======================
 * The seed below is committed to this repository and is public knowledge on
 * purpose. Anyone can derive the private half, so this key proves nothing and
 * protects nothing. It exists so that both sides can produce byte-identical
 * fixtures without coordinating key material.
 *
 * NEVER use this key for anything real. A real deployment generates its keypair
 * with a CSPRNG and keeps the private half out of the repository entirely — the
 * generated `*.private.pem` here is ignored by `.gitignore` precisely so that no
 * one mistakes a local copy of it for something worth keeping.
 * ===========================================================================
 *
 * Run with:  bun fixtures/shopping/keys/derive-test-keys.ts
 *
 * It writes:
 *   agent_a_test.public.pem    (committed — B trusts this, per README §5)
 *   agent_a_test.private.pem   (ignored  — A uses this to sign, tests only)
 *
 * The DER prefixes are the fixed structures for an Ed25519 key with no
 * parameters: PKCS#8 for the private key, SPKI for the public key. Node and Bun
 * both import them directly, so no crypto library is needed.
 */
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The fixed seed. 32 bytes, written out as hex so it is obviously a test value
 * rather than something that looks like a leaked production secret.
 */
const TEST_SEED_HEX = '0000000000000000000000000000000000000000000000000000000000000001';

/** PKCS#8 prefix for an Ed25519 private key, followed by the 32-byte seed. */
const PKCS8_ED25519_PREFIX = '302e020100300506032b657004220420';

const here = import.meta.dir;
const seed = Buffer.from(TEST_SEED_HEX, 'hex');

if (seed.length !== 32) {
  throw new Error(`the test seed must be 32 bytes, got ${seed.length}`);
}

const privateKey = createPrivateKey({
  key: Buffer.from(PKCS8_ED25519_PREFIX + TEST_SEED_HEX, 'hex'),
  format: 'der',
  type: 'pkcs8',
});

const publicKey = createPublicKey(privateKey);

const publicPem = publicKey.export({ format: 'pem', type: 'spki' }) as string;
const privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;

writeFileSync(join(here, 'agent_a_test.public.pem'), publicPem, 'utf8');
writeFileSync(join(here, 'agent_a_test.private.pem'), privatePem, 'utf8');

console.log('wrote agent_a_test.public.pem (committed)');
console.log('wrote agent_a_test.private.pem (ignored — tests only, never commit)');
console.log('');
console.log('public key fingerprint (sha256, first 16 hex):');
const { createHash } = await import('node:crypto');
const der = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
console.log(`  ${createHash('sha256').update(der).digest('hex').slice(0, 16)}`);
