# Shopping demo pages

The user page keeps three kinds of facts separate: `draft` contains editable form
values, `serverSession` contains the last validated API response, and `uiStatus`
contains request and recovery state. `deriveViewModel(state, now)` determines
actions, quote expiry, basket totals and notices without reading the DOM. Event
handlers update the draft; rendering displays the resulting view model.
`draftFromSession(session, preferences)` creates a detached draft before form
restoration, preserving the chosen input mode and original agent message. The
natural expiry timer updates countdown, confirmation and planner actions from
one view without rebuilding candidate controls or form inputs.

The four workflow cards slide horizontally. The displayed card is independent of
server facts: successful search, quote and purchase actions advance it, while
step buttons only allow returning to earlier cards. Background health checks and
the expiry timer preserve the displayed card and the draft. Inactive cards are
inert and hidden from assistive navigation. Pending purchase recovery remains
available outside the cards, and returning never unlocks a pending purchase.

The portal's user entry restores unpaid progress at its original step. Once the
previous order is confirmed and its simulated payment status is `paid`, the entry
starts a fresh request view with default fields. A one-time `start=1` navigation
marker is consumed before initialization; ordinary direct entry and reload retain
session recovery. Pending discovery and original-attempt recovery run first. A
failed discovery or unresolved purchase keeps its facts and lock, with recovery
available outside the cards. No saved sessions, cookies or orders are removed.

Merchant pages show customer-facing product and order information without internal
merchant, catalog, entry, quote or attempt identifiers. Their refresh timestamp is
the completion time of the last validated snapshot; loading or failed reads leave
that timestamp unchanged. Normal order numbers remain available for lookup.

`public/contracts.js` is generated from the pure
`packages/shopping-contracts/src/browser.ts` entry. It includes response parsers
and shared workflow rules, and cannot import server signing or storage modules.
The local API serves files from `public`, so build this package before opening
the pages in a fresh checkout. The generated bundle is ignored by Git.

Use the repository's pinned Bun 1.3.13:

```text
bun run --cwd apps/shopping-agent-web build
bun run --cwd apps/shopping-agent-web typecheck
bun run --cwd apps/shopping-agent-web lint
bun run --cwd apps/shopping-agent-web check
bun run --cwd apps/shopping-agent-web test
```

`typecheck` checks browser JavaScript using JSDoc and shared response types; the
type fixtures also prove that private fields, wrong field types and invalid DOM
properties produce compiler errors. `lint` runs ESLint on hand-written browser
modules. `check` separately verifies JavaScript syntax and required static assets;
it requires the generated bundle from `build` or `contracts:build`.

Unit tests cover pure UI decisions. The repository's browser recovery, basket and
merchant checks continue to verify network races, the original purchase attempt,
explicit confirmation and preservation of records after pagination failures.
After building the browser contract bundle, run
`node apps/shopping-agent-web/scripts/expiry-browser-check.mjs` from the repository
root to check a real five-second quote expiry. It validates local fixture DTOs,
checks all time-dependent regions, and requires zero purchase requests and page
errors. Screenshots and JSON are written to `.codex-tmp/shopping-expiry-check`;
set `SHOPPING_EXPIRY_OUTPUT_DIR` to choose another output directory. It uses the
existing browser runtime and does not download dependencies.

`bun run shopping:merchant:presentation:browser` checks timestamp preservation,
identifier-free visible content, safe failure messages and mobile layout using
isolated local fixtures. Its output defaults to `.codex-tmp/merchant-presentation-check`;
set `SHOPPING_MERCHANT_PRESENTATION_OUTPUT` to choose another directory.

`bun run shopping:portal:browser` verifies paid-order entry, unpaid progress
restoration, ordinary reloads and unresolved purchase locks using isolated local
fixtures. Reports and screenshots default to `.codex-tmp/portal-entry-browser-check`;
set `SHOPPING_PORTAL_ENTRY_OUTPUT` to choose another directory.
