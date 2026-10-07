# Shopping fixtures

Fixed, committed test data for the local coffee-shopping demo. A can build
against these **before** the merchant service exists, and both sides can point
at one shared set of numbers instead of re-deriving them.

These fixtures are a demo artifact. They are not part of the OCP Catalog
standard.

## Why they are generated but also committed

Every file here is written by [`generate.ts`](./generate.ts), and the output is
committed. That combination is deliberate:

- **Committed**, so A can `git clone` and start immediately — no build step
  stands between A and a working request body.
- **Generated**, so the hashes and signatures are *derived* rather than
  hand-edited. A hand-written `terms_hash` is a value nobody can recompute, and
  a hand-written signature is a value that is almost certainly wrong.

The risk of committing generated output is drift: someone edits a fixture by
hand and the generator no longer reproduces it. That risk is covered by
`packages/shopping-contracts/src/fixtures.test.ts`, which parses every file here
through the real schemas and verifies every signature against the committed
public key. If you change a fixture by hand, the tests will tell you.

To regenerate:

```bash
bun fixtures/shopping/generate.ts
```

The generator contains no `new Date()` and no randomness, so re-running it
produces byte-identical output. If it does not, something non-deterministic
slipped in and that is itself a bug worth fixing.

## What "now" means

Every fixture is anchored to a fixed instant:

```
2026-10-07T10:05:00.000Z
```

Nothing in here reads the wall clock, so the expired fixtures stay expired and
the valid ones stay valid forever. A test that needed the real clock would start
failing on a date nobody wrote down.

## Layout

| Path | What it is |
|---|---|
| `catalog.coffee.json` | Five catalog entries: an affordable latte, a cheap americano, an over-budget gift box, a sold-out item, a low-stock item |
| `manifest.json` | The OCP manifest, declaring only filters the merchant really implements |
| `health.json` | OCP health response |
| `query-result.json` | A `CatalogQueryResult` for the keyword `拿铁` |
| `resolve.json` | A `ResolvableReference` including the checkout `ActionBinding` |
| `discovery.json` | The `.well-known` discovery document |
| `quotes/` | One valid pickup quote, a delivery quote that lands *exactly* on the 30元 budget, an expired one, an over-budget one |
| `authorization/` | Six proofs: valid, plus five that each fail for exactly one reason |
| `checkouts/` | A valid checkout body, and one with no proof |
| `attempts/` | `processing`, `confirmed`, `failed` |
| `orders/` | `confirmed`, `processing`, `failed` |
| `faults.json` | Names of the failure modes Phase 2 must implement |
| `keys/` | The test public key (private half is generated locally and never committed) |

## The authorization fixtures

These are the ones worth understanding, because a negative fixture that fails
for the *wrong* reason proves nothing.

| File | Signature | In date | Merchant | Terms hash |
|---|---|---|---|---|
| `valid.json` | verifies | yes | matches | matches |
| `expired.json` | verifies | **no** | matches | matches |
| `wrong-merchant.json` | verifies | yes | **no** | matches |
| `wrong-terms-hash.json` | verifies | yes | matches | **no** |
| `tampered-signature.json` | **no** | yes | matches | matches |
| `replayed-other-attempt.json` | **no** | yes | matches | matches |

Only one column is "no" per row. That is what makes each file a test of one
specific rule rather than a test of "something rejected it".

The last two fail verification because their bytes were edited *after* signing —
`tampered-signature.json` by corrupting the signature, and
`replayed-other-attempt.json` by changing `purchase_attempt_id` inside the signed
payload. The second is the important one: it is the fixture that catches a
verifier which validates everything except that the authorization is bound to
*this* attempt.

## Keys

`keys/agent_a_test.public.pem` is committed. It is a **test key derived from a
committed, publicly-known seed** — it protects nothing and proves nothing, and
it exists only so both sides can produce identical signatures without
coordinating key material.

The private half is generated locally by
[`keys/derive-test-keys.ts`](./keys/derive-test-keys.ts) and gitignored. It is
never committed even though this particular key is public knowledge, because a
repository that tolerates a committed private key is one where a real one
eventually lands.

## Faults

`faults.json` is a catalogue, not an implementation. It names the failure modes
the merchant service must support in test mode:

- `payment_timeout_then_succeed` — the payment is slow enough that checkout
  cannot answer; the result is eventually successful
- `payment_declined` — the simulated payment fails
- `price_raised_after_quote` — terms change between quote and checkout
- `stock_exhausted_after_quote` — the last unit is taken between quote and
  checkout
- `response_dropped_after_settlement` — the order exists but the response never
  reaches the caller

The last one is the reason `attempts/processing.json` and the `202` response
exist: the caller must be able to recover the original order instead of
purchasing again.

See [`../../docs/coffee-merchant/CONTRACT.md`](../../docs/coffee-merchant/CONTRACT.md)
for the semantics behind all of this.
