# OCP Catalog

The **Open Commerce Protocol (OCP) Catalog** — the protocol specification, its
schema/client packages, the CLI, and minimal reference implementations.

An OCP Catalog Node exposes a small HTTP surface that lets AI agents discover,
query, and resolve commercial objects (products, offers, suppliers, …) across
independent catalogs, with a separate Registration layer for discovery and a
Handshake layer for how providers feed data into a catalog.

## What's in this repo

This repo holds three tiers, in increasing order of distance from the spec:

| Tier | What it is | Where |
|---|---|---|
| **Protocol** | The specs and the schema/client packages that encode them | [`docs/specs/`](./docs/specs), [`packages/`](./packages) |
| **Skill & CLI** | Agent tooling that speaks the protocol — installable in one command | [`skills/`](./skills), [`packages/ocp-cli/`](./packages/ocp-cli), [`plugins/`](./plugins) |
| **Examples** | The smallest correct Catalog Node, in three languages | [`examples/`](./examples) |

This repository also includes the local shopping application described below.
Production reference applications live in a separate repo — see [Reference applications](#reference-applications).

## Shopping application: 一杯之间

A working application built on OCP: manual search or DeepSeek V4.1 Flash planning,
final all-in quotes, explicit user authorization, persistent inventory and recovery
of the original order after a lost checkout response. Payment is simulated locally.

```powershell
bun install --frozen-lockfile
Copy-Item .env.example .env # first setup only; keep any existing .env
# Fill DEEPSEEK_API_KEY in .env to enable Agent mode. The field is empty by default.
bun run shopping:demo:check
bun run shopping:demo
```

Open http://127.0.0.1:4310. The demo starts both the shopping application and the
merchant, and stores its keys, orders and inventory in `.codex-tmp/shopping-demo`.
Manual search works with an empty model key. Agent mode makes actual Chat
Completions requests using `deepseek-flash`; it can search and request quotes,
and waits for the user's purchase confirmation. The API key stays on the backend.

- [Application setup and recovery](docs/shopping-agent/README.md)
- [Competition demo script and contribution scope](docs/shopping-agent/COMPETITION.md)
- [Current implementation and verification status](docs/shopping-agent/STATUS.md)

Use `bun run shopping:demo --new-session` for a fresh rehearsal directory; it
preserves previous orders and recovery data. The ordinary command reuses its
existing data. The application is a single-merchant, local demonstration.

```text
docs/specs/                     Protocol specifications
  registration/v1.md              How a Catalog registers with a Registration node
  handshake/v1.md                 How a Provider registers + syncs into a Catalog
ocp.catalog.registration.v1/    Machine-readable JSON Schemas (registration)
ocp.catalog.handshake.v1/       Machine-readable JSON Schemas (handshake)

packages/
  ocp-schema/                   Zod schemas: manifest, query, resolve, objects, health
  registration-schema/          Zod schemas for the registration protocol
  ocp-activity-schema/          Zod schemas for catalog activity events
  ocp-client/                   Typed client helpers + validators
  shared/                       Small shared utilities
  webmcp-adapter/               WebMCP adapter for browser tools
  ocp-cli/                      `ocp` CLI (published to npm)
  ocp-skill/                    `npx @ocp-catalog/skill` one-command skill installer

examples/
  typescript/  python/  go/     Minimal, spec-valid Catalog Nodes (~3 in-memory products)

skills/ocp-catalog/             The agent skill (single source of truth)
plugins/ocp-catalog/            Claude Code plugin wrapper (generated from skills/)
apps/ocp-site-web/              The OCP protocol website + docs
```

The published protocol packages (npm, scope `@ocp-catalog`):
[`ocp-schema`](https://www.npmjs.com/package/@ocp-catalog/ocp-schema),
[`registration-schema`](https://www.npmjs.com/package/@ocp-catalog/registration-schema),
[`ocp-activity-schema`](https://www.npmjs.com/package/@ocp-catalog/ocp-activity-schema),
[`ocp-client`](https://www.npmjs.com/package/@ocp-catalog/ocp-client),
[`shared`](https://www.npmjs.com/package/@ocp-catalog/shared),
[`webmcp-adapter`](https://www.npmjs.com/package/@ocp-catalog/webmcp-adapter),
[`ocp-cli`](https://www.npmjs.com/package/@ocp-catalog/ocp-cli).

## Install the agent skill

The skill teaches an agent the OCP workflow — discover a Registration node,
inspect a Catalog manifest, query with a declared query pack, resolve an entry —
and drives it through the `ocp` CLI. There are two ways to install it, from the
same source (`skills/ocp-catalog/`):

**One command, any agent:**

```bash
npx @ocp-catalog/skill                # auto-detect
npx @ocp-catalog/skill --agent claude # ~/.claude/skills
npx @ocp-catalog/skill --agent all    # Claude Code + Codex + .agents
npx @ocp-catalog/skill --scope project # ./.claude/skills in the current repo
npx @ocp-catalog/skill doctor         # where is it installed?
```

It refuses to overwrite a skill it didn't install unless you pass `--force`, and
`--dry-run` prints the plan without touching disk.

**As a Claude Code plugin:**

```
/plugin marketplace add Open-Commerce-Protocol/OCP-Catalog
/plugin install ocp-catalog@ocp-catalog
```

If you already use the CLI, `ocp skill install` does the same thing.

## Reference applications

The production-grade catalog nodes, provider apps, admin UIs, the MCP server,
the skill gateway, demos, and deploy tooling live in a separate repo:

**[Open-Commerce-Protocol/ocp-catalog-instances](https://github.com/Open-Commerce-Protocol/ocp-catalog-instances)**

It depends on the protocol packages above from npm.

> The full pre-split monorepo history (all applications) is preserved on the
> [`legacy-monorepo`](https://github.com/Open-Commerce-Protocol/OCP-Catalog/tree/legacy-monorepo)
> branch and the `pre-split-monorepo` tag.

## A minimal Catalog Node

A spec-valid Catalog Node answers five endpoints. See
[`examples/`](./examples) for complete implementations in TypeScript, Python, and Go.

| Method | Path | Returns |
|---|---|---|
| GET | `/.well-known/ocp-catalog` | discovery |
| GET | `/ocp/manifest` | capabilities + query packs |
| GET | `/ocp/health` | liveness |
| POST | `/ocp/query` | search entries |
| POST | `/ocp/resolve` | resolve an entry into action bindings |

## Develop

```bash
bun install
bun run typecheck
bun test
bun run test:all       # includes all shopping HTTP/configuration/integration tests
bun run build          # build the packages + site
bun run site:dev       # run the protocol website
bun run skill:sync     # regenerate the skill copies after editing skills/
bun run skill:check    # fail if a generated skill copy has drifted
```

Requires Bun **1.3.13**, matching `packageManager` and CI. Root startup and validation
commands verify this version before proceeding. The minimal examples each have their own README under
[`examples/`](./examples).

`skills/ocp-catalog/` is the single source of truth for the skill. The npm
payload and the Claude Code plugin copy are both generated from it by
`scripts/sync-skill-copies.ts` — edit the source, then run `skill:sync`.

## Documentation

- [Registration v1 spec](./docs/specs/registration/v1.md)
- [Handshake v1 spec](./docs/specs/handshake/v1.md)
- [docs/README.md](./docs/README.md)

## Contributing and security

- See [CONTRIBUTING.md](./CONTRIBUTING.md) before opening an issue or pull request.
- Report vulnerabilities privately as described in [SECURITY.md](./SECURITY.md). Do not publicly disclose unresolved security issues.

## License

MIT — see [LICENSE](./LICENSE).
