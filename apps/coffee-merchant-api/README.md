# coffee-merchant-api

The socket the demo coffee merchant listens on. Everything the merchant *does*
lives in [`packages/merchant-core`](../../packages/merchant-core/src/index.ts);
this package only reads configuration, opens the port and closes the database on
the way out.

**This is a demo application, not an OCP Catalog protocol capability.** The payment
is a local simulation with no provider behind it, and caller identity is a header
the caller writes itself. See [CONTRACT.md](../../docs/coffee-merchant/CONTRACT.md)
for the frozen contract and [HANDOFF-A.md](../../docs/coffee-merchant/HANDOFF-A.md)
for what Agent A still needs to do.

## Status: not yet startable through the workspace

Root `package.json` lists workspaces as `["packages/*", "examples/typescript",
"apps/ocp-site-web"]`. There is **no `apps/*` glob**, so this package is not
resolved by `bun install`, is not seen by `turbo`, and its
`@ocp-catalog/merchant-core` import does not resolve. That is a one-line change
owned by Agent A — see [HANDOFF-A.md](../../docs/coffee-merchant/HANDOFF-A.md) §1.1.

Until then, `bun run --cwd apps/coffee-merchant-api start` will fail on module
resolution. Nothing about the app itself is unfinished; it is unregistered.

With the dependency linked by hand, it has been run and exercised over real HTTP:
discovery, health, a `拿铁` query returning the latte, a quote at `total_minor`
2500, resolve, a CORS preflight, `401` for a missing caller and `404` for an
unknown route. Configuration failures — missing `MERCHANT_DB_PATH`, an
unreadable database path, a port already in use, an unknown fault name — each
exit 1 with a message rather than a stack trace.

To run it before that line lands, link the dependency by hand — `node_modules` is
gitignored, so this changes no tracked file:

```bash
# from apps/coffee-merchant-api
mkdir -p node_modules/@ocp-catalog
# The target is resolved relative to the link's own directory, not the cwd.
ln -s ../../../../packages/merchant-core node_modules/@ocp-catalog/merchant-core
# Windows: a junction works without elevation, e.g.
#   fs.symlinkSync(target, link, 'junction')
bun src/server.ts --check
```

## Running it

Once registered (or linked as above):

```bash
cp .env.example .env          # then edit; MERCHANT_DB_PATH is required
# build the trusted-keys file from the committed test key:
bun -e 'const p="../../fixtures/shopping/keys/agent_a_test.public.pem";await Bun.write("trusted-keys.json",JSON.stringify({agent_a_test:await Bun.file(p).text()},null,2))'
bun run start
```

`--check` validates the configuration and the database path, prints the same
startup summary and exits — useful when the port is busy and you want to know
whether the problem is configuration or the socket.

`--clear` deletes every row from the merchant's data tables and exits. Two things
gate it, and both come from contract §11 D10 (*"清空数据工具只作用于显式测试存储，
默认不自动清空"*):

- **`MERCHANT_TEST_MODE=1` is required.** It is the declaration that this database
  is a test database. Without it the command exits 1 and — because the check runs
  before the store is opened — does not create the database it just refused to
  clear. `MERCHANT_DB_PATH` pointing somewhere real is then not enough on its own.
- **Nothing calls it automatically.** It is reachable only through this flag; no
  part of starting or serving the merchant clears anything.

```bash
MERCHANT_TEST_MODE=1 MERCHANT_DB_PATH=./merchant.db bun run start --clear
```

It prints the path it cleared and the row count per table, so a clear that landed
on the wrong file is visible rather than implied. Two behaviours worth knowing:
the table list is read from the schema rather than hardcoded, so a table added by
a later migration is cleared without anyone remembering to update a list; and a
path that does not exist yet is created empty and reported as `0 row(s)`, which is
what starting the server would have done with it. Deletion is not secure erasure —
see [What is not done](#what-is-not-done).

## Endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/.well-known/ocp-catalog` | discovery; the only URL a caller knows in advance |
| GET | `/ocp/manifest` | declares only the filters actually implemented |
| GET | `/ocp/health` | |
| POST | `/ocp/query` | `filters` is a strict, closed set |
| POST | `/ocp/resolve` | where the caller picks up the checkout entry point |
| POST | `/commerce/v1/quotes` | final price including fees, plus `terms_hash` |
| POST | `/commerce/v1/checkouts` | `Idempotency-Key` header; **200 or 202**, never 5xx-as-failure |
| GET | `/commerce/v1/purchase-attempts/:id` | |
| GET | `/commerce/v1/orders/:id` | |

Semantics belong to the contract, not to this README. Three that are easy to get
wrong are called out in [HANDOFF-A.md](../../docs/coffee-merchant/HANDOFF-A.md) §3:
the checkout `202` is *unknown*, not failure; the idempotency key travels in a
header; and the query `filters` set is closed.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `MERCHANT_HOST` | `127.0.0.1` | read here, not in `config.ts`: it is a property of the socket |
| `MERCHANT_PORT` | `8787` | |
| `MERCHANT_DB_PATH` | **required** | no default on purpose — an in-memory database would accept orders and lose them on restart |
| `MERCHANT_PUBLIC_BASE_URL` | `http://127.0.0.1:<port>` | what discovery and manifest advertise; must be reachable by the caller |
| `MERCHANT_ALLOWED_ORIGINS` | empty | comma separated; empty means no cross-origin browser access |
| `MERCHANT_TRUSTED_KEYS_PATH` | unset | JSON object of `key_id` → PEM public key |
| `MERCHANT_QUOTE_TTL_SECONDS` | `900` | matches the fixture window |
| `MERCHANT_CHECKOUT_DEADLINE_MS` | `5000` | beyond this a checkout answers `202`; **max 225000** — a longer settlement could not be served, so it is a startup error rather than a silent clamp |
| `MERCHANT_TEST_MODE` | `0` | fault injection is unreachable without it, and `--clear` refuses without it |
| `MERCHANT_FAULTS` | unset | setting this without test mode is a startup error, not a silent no-op |

Bun loads `.env` from the working directory, so these are read from this
directory when the server is started through this package.

## Security posture

- **Loopback by default.** Caller identity is `x-dev-caller-id`, a header the
  caller writes (contract §9 D8). Bound to `0.0.0.0`, anything that can reach the
  port can act as any caller. The server prints a warning when bound elsewhere.
- **Trusted keys come from configuration only.** A public key arriving inside a
  request is never a source of trust. With no keys configured the server still
  starts and rejects every checkout — fail-closed.
- **No real payment.** The payment module is a local simulation; no commercial API
  is contacted, and no real money moves.
- **Invalid configuration exits non-zero before the port opens**, listing every
  problem at once. A merchant that started half-configured would take orders and
  reject their authorizations, which looks like a signing bug and is not one.

## What is not done

- No authentication beyond the demo header — there is no account system.
- No TLS; the demo speaks plain HTTP on loopback.
- **`--clear` deletes rows; it does not shred them.** SQLite keeps freed pages in
  the file and the write-ahead log holds recent pages until it is checkpointed, so
  bytes of cleared rows can survive until they are overwritten. A cleared database
  is empty, not erased — do not treat the flag as a way to remove data you are
  obliged to destroy. The tool prints this caveat on every run rather than leaving
  it to the source.
- **This package has no route tests, deliberately** — the routes live in
  `merchant-core` and are covered there by the route-level suite, which is the
  reason `handleRequest` is a plain `Request -> Response` function. What *is*
  tested here is the timeout budget (`src/deadline.test.ts`), because it is the
  one piece of logic that belongs to neither package alone: `config.ts` bounds
  the deadline without knowing how long a socket may stay open, and getting the
  pair wrong means a slow checkout is hung up on where the contract promises
  `202`. Untested here: configuration loading, listening and shutdown, all of
  which need a real port.
- **`src/deadline.ts` is a leaf module on purpose.** Root `bun test` scans the
  whole tree, including directories outside the workspace, so a test file here
  that imported `merchant-core` would fail the root gate on any checkout where
  the `apps/*` workspace entry has not been added yet — making a registration
  omission look like broken app code. Keeping the arithmetic free of imports
  means these tests run either way.
- **Shutdown on an external signal is unverified on Windows.** The `SIGINT` /
  `SIGTERM` handler is registered and correct for a console `Ctrl+C`, but on this
  machine a signal delivered from another process terminates the server without
  running it, so the database is not closed on that path. That is survivable —
  SQLite recovers the write-ahead log the next time it opens the file — but it has
  not been observed working, only reasoned about.
