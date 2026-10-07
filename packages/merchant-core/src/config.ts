/**
 * Configuration, read from the environment and validated as a whole.
 *
 * Contract §11 D10 requires everything deployment-specific — port, database
 * path, allowed browser origins, trusted authorization keys — to be declared
 * explicitly rather than discovered. Nothing here reads another service's
 * production configuration, and nothing has a default that would silently point
 * at real data.
 *
 * Two defaults are deliberately absent:
 *
 *   - `MERCHANT_DB_PATH` has no default. A default of `:memory:` would look
 *     like it worked and lose every order on restart, which is the exact
 *     failure the idempotency requirement exists to prevent.
 *   - trusted keys have no built-in value. If none are configured the merchant
 *     still starts, but every authorization fails to verify — fail-closed,
 *     because the alternative (trusting a key that arrived in the request) means
 *     any caller can sign its own permission.
 *
 * Validation collects every problem before throwing. Fixing configuration one
 * error per restart is a waste of a person's afternoon.
 */
import { createPublicKey, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { MERCHANT_FAULTS, parseFaultList, type MerchantFault } from './faults';

/**
 * Fixed demo identity.
 *
 * These are constants rather than environment variables on purpose: the
 * committed fixtures, the signed authorizations and the `terms_hash` of every
 * quote all embed them. Making them configurable would let a deployment start
 * successfully and then fail every signature check against A's fixtures.
 */
export const MERCHANT_ID = 'merchant_coffee_demo';
export const CATALOG_ID = 'catalog_coffee_demo';
export const PROVIDER_ID = 'provider_coffee_demo';
export const CATALOG_NAME = '演示咖啡（本地模拟）';
export const LOCATION_ID = 'store_zjg';

export const DEFAULT_PORT = 8787;
/** Quote lifetime. Matches the fixture window (10:00 -> 10:15) by default. */
export const DEFAULT_QUOTE_TTL_SECONDS = 900;
/** How long a checkout may spend settling before it reports "unknown". */
export const DEFAULT_CHECKOUT_DEADLINE_MS = 5_000;

export const ENV = {
  port: 'MERCHANT_PORT',
  databasePath: 'MERCHANT_DB_PATH',
  publicBaseUrl: 'MERCHANT_PUBLIC_BASE_URL',
  allowedOrigins: 'MERCHANT_ALLOWED_ORIGINS',
  trustedKeysPath: 'MERCHANT_TRUSTED_KEYS_PATH',
  testMode: 'MERCHANT_TEST_MODE',
  faults: 'MERCHANT_FAULTS',
  quoteTtlSeconds: 'MERCHANT_QUOTE_TTL_SECONDS',
  checkoutDeadlineMs: 'MERCHANT_CHECKOUT_DEADLINE_MS',
} as const;

export interface MerchantConfig {
  readonly port: number;
  readonly databasePath: string;
  /** Origin the merchant advertises for itself. No trailing slash. */
  readonly publicBaseUrl: string;
  /** Browser origins allowed by CORS. Empty means no cross-origin browser access. */
  readonly allowedOrigins: readonly string[];
  readonly merchantId: string;
  readonly catalogId: string;
  readonly providerId: string;
  readonly catalogName: string;
  readonly locationId: string;
  readonly quoteTtlSeconds: number;
  readonly checkoutDeadlineMs: number;
  readonly testMode: boolean;
  /** Empty unless `MERCHANT_TEST_MODE=1`. */
  readonly faults: ReadonlySet<MerchantFault>;
  /** Trusted public keys by `key_id`. Public halves only — never a private key. */
  readonly trustedKeys: ReadonlyMap<string, KeyObject>;
  /** Exact permitted issuer for each configured public key. */
  readonly trustedIssuers: ReadonlyMap<string, string>;
}

export class MerchantConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`invalid merchant configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'MerchantConfigError';
    this.problems = problems;
  }
}

export interface LoadConfigOptions {
  readonly env: Record<string, string | undefined>;
  /**
   * Injected so tests can supply a key file without touching the filesystem,
   * and so a future deployment can source keys from somewhere other than disk
   * without changing this function.
   */
  readonly readTextFile?: (path: string) => string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readInt(
  raw: string | undefined,
  fallback: number,
  name: string,
  problems: string[],
  bounds: { min: number; max?: number },
): number {
  const text = (raw ?? '').trim();
  if (text === '') return fallback;
  if (!/^\d+$/.test(text)) {
    problems.push(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
    return fallback;
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value)) {
    problems.push(`${name} must be a safe integer, got ${JSON.stringify(raw)}`);
    return fallback;
  }
  if (value < bounds.min) {
    problems.push(`${name} must be at least ${bounds.min}, got ${value}`);
    return fallback;
  }
  if (bounds.max !== undefined && value > bounds.max) {
    problems.push(`${name} must be at most ${bounds.max}, got ${value}`);
    return fallback;
  }
  return value;
}

function readFlag(raw: string | undefined, name: string, problems: string[]): boolean {
  const text = (raw ?? '').trim();
  if (text === '') return false;
  if (text === '1' || text.toLowerCase() === 'true') return true;
  if (text === '0' || text.toLowerCase() === 'false') return false;
  problems.push(`${name} must be 1 or 0, got ${JSON.stringify(raw)}`);
  return false;
}

function readList(raw: string | undefined): string[] {
  const values: string[] = [];
  for (const part of (raw ?? '').split(',')) {
    const value = part.trim();
    if (value !== '') values.push(value);
  }
  return values;
}

/**
 * Loads `key_id` -> { public_key_pem, issuer }. Issuer is deployment trust,
 * never an arbitrary label accepted from a signed payload.
 *
 * A key that is not Ed25519 is rejected here rather than at verification time.
 * `crypto.verify` with an RSA key and an Ed25519 algorithm throws, so accepting
 * one would turn a configuration mistake into a 500 on the first checkout
 * instead of a startup failure that names the offending key.
 */
function loadTrustedKeys(
  path: string,
  readTextFile: (path: string) => string,
  problems: string[],
  issuers: Map<string, string>,
): Map<string, KeyObject> {
  const keys = new Map<string, KeyObject>();
  const problemsBefore = problems.length;
  let text: string;
  try {
    text = readTextFile(path);
  } catch (error) {
    problems.push(`${ENV.trustedKeysPath}: cannot read ${path}: ${messageOf(error)}`);
    return keys;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    problems.push(`${ENV.trustedKeysPath}: ${path} is not valid JSON: ${messageOf(error)}`);
    return keys;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    problems.push(
      `${ENV.trustedKeysPath}: ${path} must be a JSON object mapping key_id to a public key`,
    );
    return keys;
  }

  for (const [keyId, raw] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      problems.push(`${ENV.trustedKeysPath}: key ${keyId} must declare public_key_pem and issuer`);
      continue;
    }
    const { public_key_pem: pem, issuer } = raw as Record<string, unknown>;
    if (typeof issuer !== 'string' || issuer.trim() === '' || issuer.trim() !== issuer) {
      problems.push(`${ENV.trustedKeysPath}: key ${keyId} must declare a non-empty exact issuer`);
      continue;
    }
    if (typeof pem !== 'string' || pem.trim() === '') {
      problems.push(`${ENV.trustedKeysPath}: key ${keyId} must be a PEM string`);
      continue;
    }
    let key: KeyObject;
    try {
      key = createPublicKey(pem);
    } catch (error) {
      problems.push(`${ENV.trustedKeysPath}: key ${keyId} is not a usable public key: ${messageOf(error)}`);
      continue;
    }
    if (key.asymmetricKeyType !== 'ed25519') {
      problems.push(
        `${ENV.trustedKeysPath}: key ${keyId} is ${key.asymmetricKeyType ?? 'of unknown type'}, but the authorization scheme is ed25519`,
      );
      continue;
    }
    keys.set(keyId, key);
    issuers.set(keyId, issuer);
  }

  // A configured file that yields nothing is a mistake, not a choice: the
  // merchant would start and then reject every checkout. Not configuring the
  // variable at all is a different, legitimate state (read-only use).
  //
  // Skipped when an individual key already failed: the specific reason ("rsa_key
  // is rsa, but the scheme is ed25519") is strictly more useful than the summary,
  // and printing both makes a one-key mistake look like two.
  if (keys.size === 0 && problems.length === problemsBefore) {
    problems.push(`${ENV.trustedKeysPath}: ${path} contains no usable ed25519 public key`);
  }
  return keys;
}

export function loadConfig(options: LoadConfigOptions): MerchantConfig {
  const { env, readTextFile = (path: string) => readFileSync(path, 'utf8') } = options;
  const problems: string[] = [];

  const port = readInt(env[ENV.port], DEFAULT_PORT, ENV.port, problems, { min: 1, max: 65535 });
  const quoteTtlSeconds = readInt(
    env[ENV.quoteTtlSeconds],
    DEFAULT_QUOTE_TTL_SECONDS,
    ENV.quoteTtlSeconds,
    problems,
    { min: 1 },
  );
  const checkoutDeadlineMs = readInt(
    env[ENV.checkoutDeadlineMs],
    DEFAULT_CHECKOUT_DEADLINE_MS,
    ENV.checkoutDeadlineMs,
    problems,
    { min: 1 },
  );

  const databasePath = (env[ENV.databasePath] ?? '').trim();
  if (databasePath === '') {
    problems.push(
      `${ENV.databasePath} is required (for example ./merchant.db). There is no default: an in-memory database would accept orders and lose them on restart, which is precisely what the idempotency requirement forbids.`,
    );
  }

  const testMode = readFlag(env[ENV.testMode], ENV.testMode, problems);

  const parsedFaults = parseFaultList(env[ENV.faults]);
  if (parsedFaults.unknown.length > 0) {
    problems.push(
      `${ENV.faults}: unknown fault(s) ${parsedFaults.unknown.join(', ')}; known faults are ${MERCHANT_FAULTS.join(', ')}`,
    );
  }
  const faults = new Set<MerchantFault>();
  if (parsedFaults.faults.length > 0) {
    if (testMode) {
      for (const fault of parsedFaults.faults) faults.add(fault);
    } else {
      // Refusing beats ignoring. A run that silently dropped the requested
      // faults would be reported as "the fault was exercised" while the honest
      // code path never ran.
      problems.push(
        `${ENV.faults} is set but ${ENV.testMode} is not enabled; fault injection is only reachable in test mode`,
      );
    }
  }

  const trustedKeysPath = (env[ENV.trustedKeysPath] ?? '').trim();
  const trustedIssuers = new Map<string, string>();
  const trustedKeys =
    trustedKeysPath === '' ? new Map<string, KeyObject>() : loadTrustedKeys(trustedKeysPath, readTextFile, problems, trustedIssuers);

  const publicBaseUrl = (
    (env[ENV.publicBaseUrl] ?? '').trim() || `http://127.0.0.1:${port}`
  ).replace(/\/+$/, '');

  if (problems.length > 0) throw new MerchantConfigError(problems);

  return {
    port,
    databasePath,
    publicBaseUrl,
    allowedOrigins: readList(env[ENV.allowedOrigins]),
    merchantId: MERCHANT_ID,
    catalogId: CATALOG_ID,
    providerId: PROVIDER_ID,
    catalogName: CATALOG_NAME,
    locationId: LOCATION_ID,
    quoteTtlSeconds,
    checkoutDeadlineMs,
    testMode,
    faults,
    trustedKeys,
    trustedIssuers,
  };
}
