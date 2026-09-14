# ssh-client — Handover

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

- Local: `projects/ssh-client`, branch `feature/ssh-client-implementation`
- SSH client **implemented** (C1–C7) with unit tests, Docker E2E, and docs;
  reviewed locally, still `v0.0.0` pending release
- No live-router smoke run yet (requires explicit user approval)

## Implementation complete (v0.1.0 candidate)

- **Exists now:** `SshClient` (`connect` / `exec` / `disconnect` / `connected`),
  `SshClientError` (`connect | auth | timeout | closed | invalid`), host-key
  pinning + `fingerprintSha256`, interactive shell I/O with `--- MORE ---`
  pager, serialized exec with auto-reconnect and `maxOutputBytes` cap
  (default 8 MiB), README + `docs/usage.md`, `SSH_*` `.env.example`,
  opt-in `tools/live-smoke.mjs`, Docker Ubuntu E2E (`docker/`, `tools/e2e.sh`).
- **Test gates:** `npm run ci` (lint + unit tests + build) and
  `npm run test:e2e` (requires Docker).
- **NOT done:** release branch / tag, version bump to `0.1.0`, npm publish,
  live-router smoke.

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
