#!/usr/bin/env bun
/**
 * `apps/coffee-merchant-api` — the socket the merchant listens on.
 *
 * Everything the merchant *does* lives in `@ocp-catalog/merchant-core`. This file
 * decides only where it listens and what it does when told to stop, which is why
 * it is short: `handleRequest` is a plain `Request -> Response` function reachable
 * from `bun test` without opening a port, so the routes are covered by that
 * package's suite and there is no second definition of the API here to drift out
 * of step with it.
 *
 * Two decisions in here are security decisions rather than conveniences:
 *
 *   - The listen address defaults to loopback. Caller identity is
 *     `x-dev-caller-id`, a header the caller writes itself (contract §9 D8), so a
 *     merchant bound to every interface lets anything that can reach the port act
 *     as any caller.
 *   - Configuration is validated before the port opens, and an invalid
 *     configuration exits non-zero with *every* problem listed. A merchant that
 *     started with a partial configuration would take orders and then reject
 *     their authorizations, which looks like a signing bug and is not one.
 *
 * The payment behind this is a local simulation with no provider attached, and the
 * caller id is not an account system. Nothing here is production-ready.
 */
import {
  MerchantConfigError,
  createMerchantContext,
  createRequestHandler,
  loadConfig,
  type MerchantConfig,
  type MerchantContext,
} from '@ocp-catalog/merchant-core';

/**
 * Read here rather than in `config.ts`: the bind address is a property of the
 * socket this app opens, not of the merchant's transaction semantics, and
 * `config.ts` holds only what the fixtures and signatures depend on.
 */
const ENV_HOST = 'MERCHANT_HOST';
const DEFAULT_HOST = '127.0.0.1';

/**
 * Headroom added on top of the settlement deadline before the socket gives up.
 *
 * A checkout may legitimately spend `checkoutDeadlineMs` settling and then answer
 * `202 processing` — an unknown outcome, not a failure (contract §8 D6). If the
 * socket timed out first, the caller would see a dropped connection instead, which
 * is exactly the "looks like failure, is not failure" confusion the contract
 * exists to prevent. Bun's own default is 10 seconds.
 */
const IDLE_TIMEOUT_HEADROOM_S = 30;
/** Bun rejects anything above 255 seconds. */
const IDLE_TIMEOUT_MAX_S = 255;

/**
 * The longest settlement deadline that still gets the full headroom above.
 *
 * Bun's ceiling is hard, so a longer deadline cannot be served the way the
 * constant above describes: the timeout would be clamped to the ceiling and the
 * socket would hang up while the checkout was still settling. Note that the
 * deadline only has to *exceed the ceiling* to break the contract, but anything
 * above this value has already lost part of the headroom — and a demo whose
 * deadline is measured in minutes is a misconfiguration, not a use case worth
 * supporting with a narrower margin. See `assertDeadlineFitsSocket`.
 */
const MAX_DEADLINE_WITH_HEADROOM_MS = (IDLE_TIMEOUT_MAX_S - IDLE_TIMEOUT_HEADROOM_S) * 1000;

const USAGE = `Usage: bun run start [--check]

  --check   Validate the configuration and the database path, print a summary,
            then exit without opening a port.

Configuration comes from the environment. See .env.example in this directory.`;

/* ----------------------------------------------------------------- exit path */

/**
 * Prints to stderr and exits non-zero. Startup output goes to stdout so that
 * `bun run start > /dev/null` still shows problems.
 */
function fail(problem: string): never {
  console.error(`coffee-merchant-api: ${problem}`);
  process.exit(1);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ---------------------------------------------------------------------- boot */

/**
 * Opens the store, or exits with the one reason that matters.
 *
 * `openMerchantDb` throws a `SQLiteError` when the path cannot be opened, and the
 * most ordinary way to get there is a directory that does not exist — SQLite
 * creates the file, not the folders above it. Left uncaught, that reaches the
 * operator as a stack trace pointing into `merchant-core`, which reads like a bug
 * in the library rather than a typo in `MERCHANT_DB_PATH`.
 */
function openContext(config: MerchantConfig): MerchantContext {
  try {
    return createMerchantContext({ config });
  } catch (error) {
    fail(
      `cannot open the database at ${config.databasePath}: ${messageOf(error)}\n\n` +
        'SQLite creates the file but not the directories leading to it; create them first.',
    );
  }
}

function readConfig(): MerchantConfig {
  try {
    return loadConfig({ env: process.env });
  } catch (error) {
    if (error instanceof MerchantConfigError) {
      fail(`${error.message}\n\nSee apps/coffee-merchant-api/.env.example.`);
    }
    throw error;
  }
}

function resolveHost(env: Record<string, string | undefined>): string {
  return (env[ENV_HOST] ?? '').trim() || DEFAULT_HOST;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function isLoopback(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

/** `0.0.0.0` is a valid bind address but not a browsable one. */
function hostForDisplay(host: string): string {
  if (host === '0.0.0.0' || host === '::') return 'localhost';
  // A bare IPv6 literal in a URL is ambiguous with its port separator.
  return host.includes(':') ? `[${host}]` : host;
}

/**
 * Refuses a settlement deadline the socket cannot outlive.
 *
 * `config.ts` validates that the deadline is a positive integer and stops there:
 * it has no opinion about how long a socket may stay open, because that is a
 * property of the server rather than of the transaction. The two numbers
 * together decide whether a slow checkout can answer `202` or gets cut off, so
 * the check belongs here, where both are known. Without it the two files would
 * each be self-consistent and the pair still wrong.
 */
function assertDeadlineFitsSocket(config: MerchantConfig): void {
  if (config.checkoutDeadlineMs <= MAX_DEADLINE_WITH_HEADROOM_MS) return;
  fail(
    `MERCHANT_CHECKOUT_DEADLINE_MS is ${config.checkoutDeadlineMs}ms, above the ` +
      `${MAX_DEADLINE_WITH_HEADROOM_MS}ms this server can serve.\n\n` +
      `Bun caps a socket's idle timeout at ${IDLE_TIMEOUT_MAX_S}s, so a settlement allowed to ` +
      'run longer would be hung up on before it could answer: the caller would see a dropped ' +
      'connection where the contract promises 202 processing.',
  );
}

/**
 * The socket must outlive a settlement that runs the whole deadline, because the
 * contract answers that case with `202 processing` rather than failure (contract
 * §8 D6). `assertDeadlineFitsSocket` has already established that the ceiling
 * cannot bite below the deadline, so the `Math.min` here is belt-and-braces
 * rather than a live clamp.
 */
function idleTimeoutFor(config: MerchantConfig): number {
  const seconds = Math.ceil(config.checkoutDeadlineMs / 1000) + IDLE_TIMEOUT_HEADROOM_S;
  return Math.min(IDLE_TIMEOUT_MAX_S, seconds);
}

/* ------------------------------------------------------------------ startup */

function describeTrustedKeys(config: MerchantConfig): string {
  if (config.trustedKeys.size === 0) {
    return 'none configured (set MERCHANT_TRUSTED_KEYS_PATH)';
  }
  return [...config.trustedKeys.keys()].sort().join(', ');
}

function startupLines(
  config: MerchantConfig,
  host: string,
  port: number,
  listening: boolean,
): string[] {
  const base = `http://${hostForDisplay(host)}:${port}`;
  return [
    `coffee merchant ${listening ? 'listening on' : 'would listen on'} ${base}`,
    `  discovery   ${base}/.well-known/ocp-catalog`,
    `  merchant    ${config.merchantId}`,
    `  database    ${config.databasePath}`,
    `  trust keys  ${describeTrustedKeys(config)}`,
    '  Local simulation: payment is mocked and x-dev-caller-id is not an account system.',
  ];
}

/**
 * Conditions that are legitimate but almost never what the operator meant.
 *
 * Each of these starts fine and then produces a confusing symptom later — every
 * checkout rejected, or a browser page unable to call the merchant — so they are
 * said out loud at startup rather than left to be discovered.
 */
function startupWarnings(config: MerchantConfig, host: string): string[] {
  const warnings: string[] = [];

  if (!isLoopback(host)) {
    warnings.push(
      `bound to ${host}: x-dev-caller-id is written by the caller, so anything that can reach this port can act as any caller.`,
    );
  }
  if (config.trustedKeys.size === 0) {
    warnings.push(
      'no trusted authorization keys: every checkout will fail closed with authorization_invalid.',
    );
  }
  if (config.allowedOrigins.length === 0) {
    warnings.push(
      'no MERCHANT_ALLOWED_ORIGINS: a browser page served from another origin cannot call this merchant.',
    );
  }
  if (config.testMode) {
    warnings.push(
      config.faults.size === 0
        ? 'MERCHANT_TEST_MODE is on with no faults selected: fault injection is armed but idle.'
        : `TEST MODE: injecting ${[...config.faults].sort().join(', ')}.`,
    );
  }
  return warnings;
}

/* ------------------------------------------------------------------- serving */

function startServer(ctx: MerchantContext, hostname: string): ReturnType<typeof Bun.serve> {
  try {
    return Bun.serve({
      hostname,
      port: ctx.config.port,
      idleTimeout: idleTimeoutFor(ctx.config),
      fetch: createRequestHandler(ctx),
    });
  } catch (error) {
    // No shutdown handler is installed yet, so this is the only chance to release
    // the database and its write-ahead log before `process.exit` takes the
    // process down.
    ctx.db.close();
    return fail(
      `cannot listen on ${hostname}:${ctx.config.port}: ${messageOf(error)}\n\n` +
        'A port already in use is the usual reason. Stop the other process, or set MERCHANT_PORT.',
    );
  }
}

function installShutdown(
  server: { stop(closeActiveConnections?: boolean): Promise<void> },
  ctx: MerchantContext,
): void {
  let stopping = false;

  const shutdown = (signal: string): void => {
    if (stopping) {
      // A second signal means the first one is not finishing — a request stuck
      // past its deadline, most likely. Honour the operator rather than argue.
      process.exit(0);
    }
    stopping = true;
    console.log(`coffee merchant stopping (${signal})`);

    // Closing checkpoints the write-ahead log. Skipping it is survivable —
    // SQLite recovers the next time the file is opened — but a demo that
    // restarts constantly should not depend on recovery working every time.
    // The same callback handles rejection: a `stop()` that failed must still
    // close the database and exit, rather than leave a hung process behind.
    const finish = (): void => {
      ctx.db.close();
      process.exit(0);
    };
    void server.stop().then(finish, finish);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/* ---------------------------------------------------------------------- main */

function main(argv: readonly string[]): void {
  const unknown = argv.filter((arg) => arg !== '--check');
  if (unknown.length > 0) fail(`unknown argument(s): ${unknown.join(', ')}\n\n${USAGE}`);
  const checkOnly = argv.includes('--check');

  const config = readConfig();
  // Checks a cross-file invariant rather than one of this package's own values,
  // so it runs after `readConfig` has had its say about the deadline itself.
  assertDeadlineFitsSocket(config);
  const host = resolveHost(process.env);
  // Opening the context is also what proves the database path is usable, which is
  // the failure `--check` exists to surface without a port conflict on top of it.
  const ctx = openContext(config);

  if (checkOnly) {
    console.log(startupLines(config, host, config.port, false).join('\n'));
    console.log('configuration is valid; no port was opened.');
    ctx.db.close();
    return;
  }

  const server = startServer(ctx, host);
  // Bun reports the port it actually bound. The fallback only covers the type
  // (the server type declares `port` optional); nothing here asks for a dynamic
  // port, so the configured one is the address that was requested.
  const port = server.port ?? config.port;
  console.log(startupLines(config, host, port, true).join('\n'));
  for (const warning of startupWarnings(config, host)) console.warn(`warning: ${warning}`);

  installShutdown(server, ctx);
}

// Guarded so that importing this file (a future test, or a REPL) does not start
// a server as a side effect.
if (import.meta.main) {
  main(process.argv.slice(2));
}
