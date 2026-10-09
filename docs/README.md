# OCP Catalog Docs

This directory holds the protocol-level documentation for the OCP Catalog. The
implementation-facing docs (architecture, operations, integrations, reference
agents) live with the applications in the
[ocp-catalog-instances](https://github.com/Open-Commerce-Protocol/ocp-catalog-instances)
repo.

## Local shopping application

This repository also contains the local application **一杯之间**. Start with
[setup and recovery](shopping-agent/README.md), [the competition demonstration](shopping-agent/COMPETITION.md),
and [implementation status](shopping-agent/STATUS.md).

The local [audit remediation](AUDIT-REMEDIATION-2026-10-08.md) and
[engineering optimization](ENGINEERING-OPTIMIZATION-2026-10-08.md) and
[acceptance follow-up](ENGINEERING-FOLLOWUP-2026-10-09.md) records describe
the changes, verification results, and recovery limits.

## Source Of Truth

Use this order when protocol descriptions conflict:

1. [Registration v1](./specs/registration/v1.md) defines how a Catalog Node registers with an OCP Catalog Registration node and how agents discover Catalog route hints.
2. [Handshake v1](./specs/handshake/v1.md) defines how a Provider registers with a Catalog Node and how object sync is negotiated.

For system design, repository architecture, and engineering standards of the
reference implementation, see the `docs/` directory of the instances repo.

## Directory Map

- `specs/`: stable protocol specifications (Registration v1, Handshake v1).

The machine-readable JSON Schemas for these protocols live at the repository root
in `ocp.catalog.registration.v1/` and `ocp.catalog.handshake.v1/`.

## Protocol Notes

- Registration and Handshake are separate protocols. Registration selects which
  Catalog to ask; Handshake defines how Provider data enters a Catalog.
- Registration `resolve` returns a `CatalogRouteHint`. Catalog `resolve` returns
  a `ResolvableReference`.
- `CatalogRouteHint` is a compact routing, trust, health, and cache summary. The
  full capability truth remains in the Catalog manifest.
- Search returns CatalogEntry-like projections. `CommercialObject` is the sync
  envelope, not the search result itself.
