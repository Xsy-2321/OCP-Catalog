---
name: ocp-catalog
description: "Use when Codex needs to work with OCP Catalog protocols and tooling: discover or search Registration nodes, inspect Catalog manifests, query Catalog entries, resolve results, validate OCP payloads, inspect public OCP activity events, or operate OCP through the repository CLI. This skill is for real OCP protocol workflows, not ordinary repository maintenance."
---

# OCP Catalog

## Core Rule

Use the repository CLI or shared client for protocol calls. Do not reimplement OCP state machines inside the skill, do not store secrets in skill files, and do not invent `catalog_id`, `query_pack`, route hints, filter fields, or object IDs.

## Workflow

1. Use Registration only to discover Catalogs.
2. Inspect the selected Catalog manifest before query or resolve.
3. Query only with manifest-declared query packs and filter fields.
4. Resolve only a selected entry when details, freshness, action binding, or policy context is needed.
5. Inspect activity through the Activity API public projection, not raw audit payloads.

## CLI First

Prefer the OCP CLI instead of hand-written HTTP calls. In a released standalone skill, run the bundled CLI through `scripts/ocp-skill-runner.ts` or call an installed `ocp` binary:

```bash
bun scripts/ocp-skill-runner.ts registration search --registration-url https://ocp.deeplumen.io/registry --query "commerce"
ocp catalog inspect http://localhost:4000/ocp/manifest
ocp events tail --activity-url https://ocp.deeplumen.io
```

The runner resolves the CLI in this order: `OCP_CLI_COMMAND`, `OCP_CLI_BIN`, bundled skill CLI, `ocp` on PATH, `bunx @ocp-catalog/ocp-cli`, then `npx @ocp-catalog/ocp-cli`.

The runner always forwards arguments without a shell. `OCP_CLI_BIN` is an executable path; `OCP_CLI_COMMAND` is either an executable alone or a JSON argv array such as `["bun", "/path/to/ocp.js"]`. Old shell expressions and command strings with prefix arguments must be migrated to JSON argv or a CLI wrapper that preserves arguments. On Windows, known npm `ocp.cmd` and `npx.cmd` shims are resolved to their package's JS entry point and run with Bun; other `.cmd`/`.bat` wrappers and shell executables are rejected. If no PATH launcher is available, the current Bun runtime runs `bun x @ocp-catalog/ocp-cli`.

If this skill is not yet installed for your agent, install it with `npx @ocp-catalog/skill` (add `--agent claude|codex|agents|all`), or add it as a Claude Code plugin from the `Open-Commerce-Protocol/OCP-Catalog` marketplace.

For command details, read `references/cli-usage.md`.

Use CLI help when choosing commands or flags:

```bash
bun scripts/ocp-skill-runner.ts help
bun scripts/ocp-skill-runner.ts registration --help
bun scripts/ocp-skill-runner.ts catalog query --help
```

Top-level help describes the standard OCP workflow. Domain help explains the protocol stage. Command help explains the command's intent, options, and examples.

## Boundaries

Read `references/protocol-boundaries.md` before designing or changing OCP integrations. The key separation is:

- Registration Node searches Catalog metadata.
- Catalog Node searches and resolves commercial objects.
- Provider supplies object data to a Catalog.
- CLI, MCP, WebMCP, plugins, and skills are adapter/tooling layers.
- Activity API collects redacted events; the public website reads only public projections.

## Query Procedure

Read `references/query-workflow.md` when the user wants a real OCP query or resolve flow.

## Activity Events

When recording OCP behavior, emit or inspect `ocp.activity.v1` events through Activity API. Do not add telemetry fields to strict OCP request bodies. Use correlation or trace headers such as `x-ocp-trace-id` to link client and server events.
