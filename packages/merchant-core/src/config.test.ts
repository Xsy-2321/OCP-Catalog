/**
 * Configuration is a security boundary, so its failures are tested as
 * behaviours rather than as parsing.
 *
 * The three that matter: a fault list outside test mode must be an error rather
 * than a silent no-op (a demo that quietly ignored it would be reported as
 * "the fault was exercised" when the branch never ran); a database path must
 * have no default (an in-memory default loses every order on restart, which is
 * the failure idempotency exists to prevent); and a non-Ed25519 key must be
 * refused at startup rather than at the first checkout.
 */
import { describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_CHECKOUT_DEADLINE_MS,
  DEFAULT_PORT,
  DEFAULT_QUOTE_TTL_SECONDS,
  ENV,
  MERCHANT_ID,
  MerchantConfigError,
  loadConfig,
} from './config';
import { TEST_KEY_ID } from './test-support';

const DB_ENV = { [ENV.databasePath]: '/tmp/test.db' };

function problemsFrom(env: Record<string, string | undefined>, readTextFile?: (path: string) => string): string[] {
  try {
    loadConfig({ env, ...(readTextFile === undefined ? {} : { readTextFile }) });
  } catch (error) {
    if (error instanceof MerchantConfigError) return [...error.problems];
    throw error;
  }
  return [];
}

const publicPem = readFileSync(join(import.meta.dir, '../../../fixtures/shopping/keys/agent_a_test.public.pem'), 'utf8');

describe('loadConfig', () => {
  test('applies documented defaults when nothing but the database path is set', () => {
    const config = loadConfig({ env: DB_ENV });

    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.quoteTtlSeconds).toBe(DEFAULT_QUOTE_TTL_SECONDS);
    expect(config.checkoutDeadlineMs).toBe(DEFAULT_CHECKOUT_DEADLINE_MS);
    expect(config.publicBaseUrl).toBe(`http://127.0.0.1:${DEFAULT_PORT}`);
    expect(config.merchantId).toBe(MERCHANT_ID);
    expect(config.testMode).toBe(false);
    expect(config.faults.size).toBe(0);
    expect(config.trustedKeys.size).toBe(0);
    expect(config.allowedOrigins).toEqual([]);
  });

  test('refuses to start without a database path, naming the variable', () => {
    const problems = problemsFrom({});

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(ENV.databasePath);
    // The reason, not just the requirement: whoever reads the error should not
    // reach for an in-memory database to silence it.
    expect(problems[0]).toContain('in-memory');
  });

  test('reports every problem at once instead of the first', () => {
    const problems = problemsFrom({ [ENV.port]: 'not-a-port', [ENV.testMode]: 'maybe' });

    expect(problems.length).toBeGreaterThanOrEqual(3);
    expect(problems.some((p) => p.startsWith(ENV.port))).toBe(true);
    expect(problems.some((p) => p.startsWith(ENV.testMode))).toBe(true);
    expect(problems.some((p) => p.startsWith(ENV.databasePath))).toBe(true);
  });

  test('rejects a requested fault when test mode is off, rather than ignoring it', () => {
    const problems = problemsFrom({ ...DB_ENV, [ENV.faults]: 'payment_declined' });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(ENV.faults);
    expect(problems[0]).toContain(ENV.testMode);
  });

  test('enables requested faults when test mode is on', () => {
    const config = loadConfig({
      env: { ...DB_ENV, [ENV.testMode]: '1', [ENV.faults]: 'payment_declined, price_raised_after_quote' },
    });

    expect([...config.faults].sort()).toEqual(['payment_declined', 'price_raised_after_quote']);
  });

  test('names the known faults when given an unknown one', () => {
    const problems = problemsFrom({ ...DB_ENV, [ENV.testMode]: '1', [ENV.faults]: 'meltdown' });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('meltdown');
    expect(problems[0]).toContain('payment_declined');
  });

  test('parses the allowed-origin list and strips empty entries', () => {
    const config = loadConfig({
      env: { ...DB_ENV, [ENV.allowedOrigins]: 'http://localhost:3000, , http://127.0.0.1:5173' },
    });

    expect(config.allowedOrigins).toEqual(['http://localhost:3000', 'http://127.0.0.1:5173']);
  });

  test('strips a trailing slash from the public base url', () => {
    const config = loadConfig({ env: { ...DB_ENV, [ENV.publicBaseUrl]: 'http://example.test:9000/' } });

    expect(config.publicBaseUrl).toBe('http://example.test:9000');
  });

  test('rejects unusable advertised URLs before discovery and Resolve can fail', () => {
    for (const value of ['merchant.local', 'ftp://example.test', 'https://example.test/demo',
      'https://user:password@example.test', 'https://example.test/?q=1', 'https://example.test/#fragment']) {
      expect(problemsFrom({ ...DB_ENV, [ENV.publicBaseUrl]: value }).join('\n')).toContain(ENV.publicBaseUrl);
    }
    expect(loadConfig({ env: { ...DB_ENV, [ENV.publicBaseUrl]: 'https://Example.test:443/' } }).publicBaseUrl)
      .toBe('https://example.test');
  });

  describe('trusted keys', () => {
    test('loads an ed25519 public key under its key id', () => {
      const config = loadConfig({
        env: { ...DB_ENV, [ENV.trustedKeysPath]: 'keys.json' },
        readTextFile: () => JSON.stringify({ [TEST_KEY_ID]: { public_key_pem: publicPem, issuer: 'agent_a_demo' } }),
      });

      expect([...config.trustedKeys.keys()]).toEqual([TEST_KEY_ID]);
      expect(config.trustedKeys.get(TEST_KEY_ID)?.asymmetricKeyType).toBe('ed25519');
      expect(config.trustedIssuers.get(TEST_KEY_ID)).toBe('agent_a_demo');
    });

    test('has no built-in key when none is configured, and does not treat that as a problem', () => {
      const config = loadConfig({ env: DB_ENV });

      // Read-only use is legitimate. Nothing is trusted, so every authorization
      // fails to verify — fail-closed, which is the point.
      expect(config.trustedKeys.size).toBe(0);
    });

    test('rejects a key that is not ed25519 at startup, naming the key', () => {
      const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const rsaPem = publicKey.export({ format: 'pem', type: 'spki' }) as string;

      const problems = problemsFrom(
        { ...DB_ENV, [ENV.trustedKeysPath]: 'keys.json' },
        () => JSON.stringify({ rsa_key: { public_key_pem: rsaPem, issuer: 'agent_a_demo' } }),
      );

      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('rsa_key');
      expect(problems[0]).toContain('ed25519');
    });

    test('rejects a configured key file that yields no usable key', () => {
      const problems = problemsFrom({ ...DB_ENV, [ENV.trustedKeysPath]: 'keys.json' }, () => '{}');

      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('no usable ed25519 public key');
    });

    test('rejects a PEM-only key without a configured issuer', () => {
      const problems = problemsFrom({ ...DB_ENV, [ENV.trustedKeysPath]: 'keys.json' },
        () => JSON.stringify({ [TEST_KEY_ID]: publicPem }));
      expect(problems.join('\n')).toContain('issuer');
    });

    test('reports an unreadable key file instead of throwing through', () => {
      const problems = problemsFrom({ ...DB_ENV, [ENV.trustedKeysPath]: 'missing.json' }, () => {
        throw new Error('ENOENT');
      });

      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('missing.json');
    });
  });
});
