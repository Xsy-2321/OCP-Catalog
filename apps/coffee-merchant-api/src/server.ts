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
  ClearRefusedError,
  MerchantConfigError,
  clearMerchantStore,
  createMerchantContext,
  createRequestHandler,
  loadConfig,
  type ClearResult,
  type MerchantConfig,
  type MerchantContext,
} from '@ocp-catalog/merchant-core';

import { deadlineProblem, idleTimeoutSeconds } from './deadline';

/**
 * Read here rather than in `config.ts`: the bind address is a property of the
 * socket this app opens, not of the merchant's transaction semantics, and
 * `config.ts` holds only what the fixtures and signatures depend on.
 */
const ENV_HOST = 'MERCHANT_HOST';
const DEFAULT_HOST = '127.0.0.1';

/**
 * The socket must outlive a settlement that runs the whole deadline, so a slow
 * checkout answers `202 processing` rather than being cut off first (contract §8
 * D6). The arithmetic, Bun's ceiling, and the check that pairs them live in
 * `./deadline`, where they are testable without opening a port. Bun's own
 * default idle timeout is 10 seconds.
 */

const USAGE = `Usage: bun run start [--check | --clear]

  --check   Validate the configuration and the database path, print a summary,
            then exit without opening a port.

  --clear   Delete every row from the merchant's data tables, then exit.
            Refused unless MERCHANT_TEST_MODE=1 (contract §11 D10: the clearing
            tool acts on explicit test storage only). It never runs as part of
            starting the server. Rows are deleted, not securely erased.

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
 * The judgement itself is `deadlineProblem` in `./deadline`; what happens *here*
 * is the refusal. `config.ts` validates that the deadline is a positive integer
 * and stops there: it has no opinion about how long a socket may stay open,
 * because that is a property of the server rather than of the transaction. Each
 * file is self-consistent on its own and the pair can still be wrong, which is
 * why the seam gets its own check rather than being implied by either.
 */
function assertDeadlineFitsSocket(deadlineMs: number): void {
  const problem = deadlineProblem(deadlineMs);
  if (problem !== null) fail(problem);
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

/**
 * Runs `--clear` and reports what it removed.
 *
 * The two gates — the flag and `MERCHANT_TEST_MODE` — live in
 * `clearMerchantStore`, next to the deletes they guard, so there is one place to
 * read rather than two that can quietly disagree. What this function adds is the
 * operator-facing half: which database was touched, which tables were emptied,
 * and how many rows went. A clear that succeeded against the wrong path is the
 * outcome worth spending four lines to make visible.
 *
 * If the configured path does not exist it is created empty and zero rows are
 * reported — the same thing starting the server would do with it. That is said
 * here rather than hidden because "cleared 0 rows" against a path typo is
 * otherwise indistinguishable from a clear that worked.
 */
function reportClear(config: MerchantConfig): void {
  let result: ClearResult;
  try {
    result = clearMerchantStore({
      databasePath: config.databasePath,
      testMode: config.testMode,
    });
  } catch (error) {
    if (error instanceof ClearRefusedError) fail(`${error.message}\n\n${USAGE}`);
    fail(`cannot clear the database at ${config.databasePath}: ${messageOf(error)}`);
  }

  console.log(`cleared ${result.databasePath}`);
  for (const entry of result.cleared) console.log(`  ${entry.table}  ${entry.rows} row(s)`);
  console.log(`  ${result.totalRows} row(s) removed in total.`);
  console.log(
    '  rows are deleted, not securely erased: SQLite keeps freed pages, and the write-ahead log holds recent ones until it is checkpointed.',
  );
}

/* ------------------------------------------------------------------- serving */

function startServer(ctx: MerchantContext, hostname: string): ReturnType<typeof Bun.serve> {
  try {
    return Bun.serve({
      hostname,
      port: ctx.config.port,
      idleTimeout: idleTimeoutSeconds(ctx.config.checkoutDeadlineMs),
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

const KNOWN_ARGS = new Set(['--check', '--clear']);

function main(argv: readonly string[]): void {
  const unknown = argv.filter((arg) => !KNOWN_ARGS.has(arg));
  if (unknown.length > 0) fail(`unknown argument(s): ${unknown.join(', ')}\n\n${USAGE}`);
  const checkOnly = argv.includes('--check');
  const clearOnly = argv.includes('--clear');
  // Both are "do one thing and exit". Silently honouring one of them would make
  // `--check --clear` a clear that was never inspected, or an inspection that
  // silently cleared.
  if (checkOnly && clearOnly) fail(`--check and --clear are different jobs; pass one.\n\n${USAGE}`);

  const config = readConfig();

  // Before `openContext`, which would open (and, for a missing file, create) the
  // database this command is about to refuse to touch.
  if (clearOnly) {
    reportClear(config);
    return;
  }

  // Checks a cross-file invariant rather than one of this package's own values,
  // so it runs after `readConfig` has had its say about the deadline itself —
  // and after the clear branch, because the deadline is a property of serving a
  // request and a clear must not be refused over a setting it never reads.
  assertDeadlineFitsSocket(config.checkoutDeadlineMs);
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
