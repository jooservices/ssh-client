# vigor3912s-client — Handover

**Created:** 2026-09-14  
**Scope this session:** scaffold + plan only (no SSH implementation yet).

## 0. Read order

1. This file
2. [`BACKLOG.md`](./BACKLOG.md) — Wave C tasks
3. SDK `projects/vigor3912s/sdk/HANDOVER.md` §6a–§6b (`REQ-SDK-1`…`6`) — **blocker** for typed dependency
4. Sibling reference (read-only): `projects/vigor3912s-mcp/src/ssh/driver.ts` (prompt, pager, host-key, mutex patterns)

## 1. Mission

Implement **`Transport`** for DrayOS over SSH so `@jooservices/vigor3912s-sdk`
can talk to a real router **without** the SDK importing SSH.

```text
sdk  --uses-->  Transport (interface)
client --implements-->  Transport   ← this package
```

## 2. Non-negotiables

- **Do not** own MCP confirm / tools / audit.
- **Do not** own typed domain ops / parsers (SDK).
- **Do not** connect to a live router in CI unit tests.
- Live E2E only with **explicit** user authorization + pinned host key.
- Never commit `.env` / credentials.
- Prefer implementing against SDK public `./transport` once REQ-SDK-1 lands.
- Branch model: `master` + `develop` only (**no `main`**).

## 3. Blockers

| Blocker | Owner | Notes |
| --- | --- | --- |
| SDK public `Transport` export (`REQ-SDK-1`) | `vigor3912s/sdk` | Until then, only scaffold/plan; optional local type mirror marked TEMP |
| Decision on package name publish | — | `@jooservices/vigor3912s-client` private until first release |

## 4. Current state

- GitHub: `jooservices/vigor3912s-client`
- Local: `projects/vigor3912s-client`
- `v0.0.0` scaffold: package metadata, stub `src/`, plan docs, CI stub
- **No** working `SshTransport` yet

## 5. Suggested implementation order

See `BACKLOG.md` Wave C (C0 → C6). Summary:

1. Wait / pair on SDK `./transport` public export  
2. `SshTransport` connect + host-key pin  
3. Interactive shell: prompt `DrayTek> `, pager `--- MORE ---`  
4. `send(frame)` one command / one exchange; timeouts; close  
5. Tests with fake ssh2 (pattern from MCP `fake-ssh2`)  
6. Optional live smoke (explicit auth)

## 6. Things NOT to do

- Do not reintroduce a full MCP `VigorClient` here (that adapter stays in MCP).
- Do not add domain command registries.
- Do not force-push `master` / `develop`.
