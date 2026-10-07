/**
 * Shared construction for the merchant's tests.
 *
 * Not exported from the package barrel and not part of the built bundle. It
 * exists so every test builds a merchant the same way production does
 * (`createMerchantContext`) instead of wiring one by hand — a hand-wired test
 * harness drifts from production quietly, and then passes for reasons that have
 * nothing to do with the code under test.
 *
 * The signing key is derived from the seed committed at
 * `fixtures/shopping/keys/derive-test-keys.ts`, so tests sign with the same key
 * whose public half B is configured to trust. It proves nothing and protects
 * nothing; it is a test key on purpose.
 */
import { createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import {
  authorizationSigningBytes,
  type AuthorizationProof,
  type AuthorizationSignedPayload,
  type Quote,
} from '@ocp-catalog/shopping-contracts';
import { manualClock, type Clock } from './clock';
import {
  CATALOG_ID,
  CATALOG_NAME,
  LOCATION_ID,
  MERCHANT_ID,
  PROVIDER_ID,
  type MerchantConfig,
} from './config';
import type { CatalogEntryRecord } from './catalog';
import type { MerchantContext } from './context';
import { CATALOG_SEED } from './data/catalog';
import { loadCatalog } from './catalog';
import { openMerchantDb } from './db';
import { createMerchantContext } from './service';
import type { MerchantFault } from './faults';

/** The `key_id` B is configured to trust in every test. */
export const TEST_KEY_ID = 'agent_a_test';

const TEST_SEED_HEX = '0000000000000000000000000000000000000000000000000000000000000001';
const PKCS8_ED25519_PREFIX = '302e020100300506032b657004220420';

let cachedPrivateKey: KeyObject | null = null;

/** The demo issuer's private key, derived from the public seed. */
export function testPrivateKey(): KeyObject {
  cachedPrivateKey ??= createPrivateKey({
    key: Buffer.from(PKCS8_ED25519_PREFIX + TEST_SEED_HEX, 'hex'),
    format: 'der',
    type: 'pkcs8',
  });
  return cachedPrivateKey;
}

export function testPublicKey(): KeyObject {
  return createPublicKey(testPrivateKey());
}

/** A fixed timestamp inside the fixture authorization's window. */
export const TEST_NOW_MS = 1_791_367_500_000;

export interface TestConfigOptions {
  readonly faults?: readonly MerchantFault[];
  readonly trustedKeys?: ReadonlyMap<string, KeyObject>;
  readonly quoteTtlSeconds?: number;
  readonly checkoutDeadlineMs?: number;
  readonly allowedOrigins?: readonly string[];
  readonly publicBaseUrl?: string;
  readonly databasePath?: string;
}

export function makeTestConfig(options: TestConfigOptions = {}): MerchantConfig {
  return {
    port: 8787,
    databasePath: options.databasePath ?? ':memory:',
    publicBaseUrl: options.publicBaseUrl ?? 'http://127.0.0.1:8787',
    allowedOrigins: options.allowedOrigins ?? [],
    merchantId: MERCHANT_ID,
    catalogId: CATALOG_ID,
    providerId: PROVIDER_ID,
    catalogName: CATALOG_NAME,
    locationId: LOCATION_ID,
    quoteTtlSeconds: options.quoteTtlSeconds ?? 900,
    checkoutDeadlineMs: options.checkoutDeadlineMs ?? 5_000,
    testMode: (options.faults ?? []).length > 0,
    faults: new Set(options.faults ?? []),
    trustedKeys:
      options.trustedKeys ?? new Map<string, KeyObject>([[TEST_KEY_ID, testPublicKey()]]),
  };
}

export interface TestContextOptions extends TestConfigOptions {
  readonly clock?: Clock;
  readonly db?: Database;
  readonly catalog?: readonly CatalogEntryRecord[];
}

export function makeTestContext(options: TestContextOptions = {}): MerchantContext {
  const { clock, db, catalog, ...configOptions } = options;
  return createMerchantContext({
    config: makeTestConfig(configOptions),
    clock: clock ?? manualClock(TEST_NOW_MS),
    catalog: catalog ?? loadCatalog(CATALOG_SEED),
    ...(db === undefined ? {} : { db }),
  });
}

/** An open database file in a directory the caller removes when done. */
export function makeTempDatabasePath(): { readonly path: string; readonly cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'merchant-core-test-'));
  return { path: join(dir, 'merchant.db'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function openTestDb(path: string): Database {
  return openMerchantDb(path);
}

/* ------------------------------------------------------------ authorizations */

export interface AuthorizationOptions {
  readonly keyId?: string;
  readonly merchantId?: string;
  readonly quoteId?: string;
  readonly termsHash?: string;
  readonly currency?: string;
  readonly maxTotalMinor?: number;
  readonly purchaseAttemptId?: string;
  readonly issuedAt?: number;
  readonly expiresAt?: number;
  readonly jti?: string;
  readonly issuer?: string;
  readonly userId?: string;
}

/** Builds the signed payload for a quote, with every field overridable. */
export function signedPayloadFor(quote: Quote, options: AuthorizationOptions = {}): AuthorizationSignedPayload {
  return {
    v: 'ocp.demo.auth.v1',
    issuer: options.issuer ?? 'agent_a_demo',
    user_id: options.userId ?? 'user_demo_1',
    merchant_id: options.merchantId ?? quote.merchant_id,
    quote_id: options.quoteId ?? quote.quote_id,
    terms_hash: options.termsHash ?? quote.terms_hash,
    currency: options.currency ?? quote.currency,
    max_total_minor: options.maxTotalMinor ?? quote.total_minor,
    purchase_attempt_id: options.purchaseAttemptId ?? 'att_test_0001',
    issued_at: options.issuedAt ?? Math.floor(TEST_NOW_MS / 1000) - 60,
    expires_at: options.expiresAt ?? Math.floor(TEST_NOW_MS / 1000) + 600,
    jti: options.jti ?? 'jti_test_0001',
  };
}

/** Signs a payload with the demo key, producing a wire-shaped proof. */
export function signPayload(payload: AuthorizationSignedPayload, keyId = TEST_KEY_ID): AuthorizationProof {
  return {
    scheme: 'ed25519',
    key_id: keyId,
    signature: sign(null, authorizationSigningBytes(payload), testPrivateKey()).toString('base64url'),
    payload,
  };
}

export function authorizationFor(quote: Quote, options: AuthorizationOptions = {}): AuthorizationProof {
  return signPayload(signedPayloadFor(quote, options), options.keyId ?? TEST_KEY_ID);
}

/** A signature that is well formed but wrong: the payload changed after signing. */
export function tamperSignature(proof: AuthorizationProof): AuthorizationProof {
  const flipped = Buffer.from(proof.signature, 'base64url');
  flipped[0] ^= 0xff;
  return { ...proof, signature: flipped.toString('base64url') };
}

/* ------------------------------------------------------------------ requests */

export function jsonRequest(
  url: string,
  body: unknown,
  init: { method?: string; headers?: Record<string, string> } = {},
): Request {
  return new Request(url, {
    method: init.method ?? 'POST',
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    body: JSON.stringify(body),
  });
}
