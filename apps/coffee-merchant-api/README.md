# coffee-merchant-api

The socket the demo coffee merchant listens on. Everything the merchant *does*
lives in [`packages/merchant-core`](../../packages/merchant-core/src/index.ts);
this package only reads configuration, opens the port and closes the database on
the way out.

**This is a demo application, not an OCP Catalog protocol capability.** The payment
is a local simulation with no provider behind it, and caller identity is a header
the caller writes itself. See [CONTRACT.md](../../docs/coffee-merchant/CONTRACT.md)
for the common `0.2.0` wire contract. A and B are now maintained together by the
project maintainer. This is a local integration candidate pending the user's
review; it has not been merged into `main` or pushed. Historical handoff files
describe the earlier collaboration.

## Workspace integration

Use the root packageManager version, **Bun 1.3.13**. This app is registered in
the root workspace. Run `bun install --frozen-lockfile`
from the repository root before starting it; no manual dependency link is needed.
The joint network suite is `tests/shopping-e2e/http-flow.test.ts`: it starts A's
actual API confirmation routes and B's `startCoffeeMerchantServer` bootstrap on
isolated ports with a fresh SQLite file and session directory.

## Running it

From this app directory, after installing the root workspace:

```powershell
Copy-Item .env.example .env   # then edit; MERCHANT_DB_PATH is required
# build the trusted-keys file from the committed test key:
bun -e 'const p="../../fixtures/shopping/keys/agent_a_test.public.pem";await Bun.write("trusted-keys.json",JSON.stringify({agent_a_test:{public_key_pem:await Bun.file(p).text(),issuer:"agent_a_demo"}},null,2))'
bun run start
```

Run `bun run check` before `bun run start` to validate the same configuration
without opening a port. Keep the SQLite path stable for everyday restarts. For
HTTP shopping, configure A's signer with the corresponding private test key,
`agent_a_test` key ID and `agent_a_demo` issuer; A sends its session user as both
the signed `user_id` and caller header. See the
[shopping startup instructions](../../docs/shopping-agent/README.md).

`--check` validates the configuration and the database path, prints the same
startup summary and exits — useful when the port is busy and you want to know
whether the problem is configuration or the socket.

## Endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/.well-known/ocp-catalog` | discovery; the only URL a caller knows in advance |
| GET | `/ocp/manifest` | declares only the filters actually implemented |
| GET | `/ocp/health` | |
| GET | `/products/:entry_id` | read-only product page advertised by Resolve; current price, stock and fees |
| POST | `/ocp/query` | `filters` is a strict, closed set |
| POST | `/ocp/resolve` | where the caller picks up the checkout entry point |
| POST | `/commerce/v1/quotes` | final price including fees, plus `terms_hash` |
| POST | `/commerce/v1/checkouts` | `Idempotency-Key` header; **200 or 202**, never 5xx-as-failure |
| GET | `/commerce/v1/purchase-attempts/:id` | |
| GET | `/commerce/v1/orders/:id` | |

Semantics are defined in the [shared contract](../../docs/coffee-merchant/CONTRACT.md):
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
| `MERCHANT_TRUSTED_KEYS_PATH` | unset | JSON object of `key_id` → `{ public_key_pem, issuer }`; issuer is matched exactly |
| `MERCHANT_QUOTE_TTL_SECONDS` | `900` | matches the fixture window |
| `MERCHANT_CHECKOUT_DEADLINE_MS` | `5000` | beyond this a checkout answers `202`; **max 225000** — a longer settlement could not be served, so it is a startup error rather than a silent clamp |
| `MERCHANT_TEST_MODE` | `0` | fault injection is unreachable without it |
| `MERCHANT_FAULTS` | unset | setting this without test mode is a startup error, not a silent no-op |

Bun loads `.env` from the working directory, so these are read from this
directory when the server is started through this package.

`MERCHANT_PUBLIC_BASE_URL` must be a complete HTTP(S) origin: no credentials,
path prefix, query or fragment. Bad addresses fail during `--check` and startup.
Only `in_stock` and `low_stock` items may be quoted and purchased. `preorder` and
`unknown` can be displayed in the catalog but do not pass `in_stock_only=true`.

## Persistent inventory and upgrades

The SQLite schema version is **3**; the wire contract is **0.2.0**. Startup migrates
v2 reservations to one row per purchase attempt and product, retaining pending
reservations and historical inventory. Quotes can contain multiple products; all
lines reserve and settle in one transaction. Delivery requires recipient, phone
and address and charges the largest selected product delivery fee once per order.
Delivery and payment remain local simulations. Startup
adds the inventory, reservation and legacy shortage tables to an existing v1
store. The first inventory seed imports its confirmed and pending attempts;
subsequent starts retain available stock. Checkout conditionally reserves stock
inside the same write transaction as the attempt, payment, order and idempotency
record. A confirmed attempt consumes that reservation without another deduction;
a definite payment failure releases it once. Processing keeps its reservation
across restarts until the original attempt is queried and settled.

Old v1 stores may already have oversold. Migration records that shortage and
keeps available stock at zero. A failed legacy pending attempt reduces the old
shortage before returning any actually available units; it cannot recreate units
already sold to confirmed orders. Migration cannot reverse historical orders or
repair an old shortage. There is no automatic replenishment or reset tool.

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
- Route-level tests remain in `merchant-core`; the joint suite also exercises
  this app's actual network bootstrap, A confirmation routes, and independent
  persistent storage. `startCoffeeMerchantServer(...).stop()` refuses new
  requests, waits for handlers already in progress, then calls `server.stop(true)`
  once to close all sockets before closing SQLite. Repeated stop calls share the
  same promise. CLI shutdown uses this same lifecycle. This order avoids the
  fixed Bun 1.3.13 Windows runtime retaining an old handler after `stop(false)`.
  Responses also declare `Connection: close`; a safe instance header lets the
  same-port restart tests verify they reached the new instance.
- **No reset tool exists.** Tests create independent storage explicitly; the app
  never clears an existing database or restores sold stock to seed quantities.
- **External signal callbacks are not guaranteed on Windows.** A process killed
  from another process can exit without its SIGINT/SIGTERM handler running.
  Graceful `stop()` and forced-process restart recovery are separate checks;
  SQLite/attempt/order/idempotency recovery after a forced exit does not prove
  that a signal callback performed a graceful shutdown.
