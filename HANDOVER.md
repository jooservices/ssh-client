# vigor3912s-client — Handover

**Created:** 2026-09-14  
**Scope:** SSH client library only.

## Mission

Ship a **standalone SSH client** (Node 24 / TypeScript) that any app can use
to open a session, run commands, and read output. Primary target environment
is a DrayTek Vigor 3912S DrayOS interactive shell, but the **public API is a
generic SSH client** — not tied to any other product’s types or workflows.

## Non-negotiables

- **Client only.** No product-specific adapters, registries, or protocol layers
  from other JOOservices apps in this package.
- Do **not** document, import, or depend on other application packages.
- Unit tests use fakes — no live router in CI.
- Live smoke only with **explicit** user approval + credentials outside git.
- Never commit `.env` / passwords / host keys as secrets in the repo.
- Branches: `master` + `develop` only (no `main`).

## Current state

- Local: `projects/vigor3912s-client`
- `v0.0.0` scaffold (metadata stub only)
- **No** working SSH session implementation yet

## Plan summary

Full plan: [`IMPLEMENTATION-PLAN.md`](./IMPLEMENTATION-PLAN.md).  
Task list: [`BACKLOG.md`](./BACKLOG.md).

Build an SSH client with:

1. Connect options (host, port, user, password, host-key pin)
2. Interactive shell I/O (prompt detection, pager, echo strip)
3. Public API: connect → run command(s) → disconnect
4. Tests with a fake SSH stack
5. Docs + `.env.example` for operators

## Things NOT to do

- Do not add application-specific command catalogs or confirm/audit flows.
- Do not couple the public API to another package’s interfaces.
- Do not force-push `master` / `develop`.
