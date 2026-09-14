# vigor3912s-client — Implementation backlog

**Status:** Scaffold approved 2026-09-14. Plan only until Wave C starts.  
**Standard gate (when coding):** `npm run ci` (lint + test + build). No `--no-verify`.

Trace: SDK `HANDOVER.md` §6a–§6b; MCP `src/ssh/driver.ts` as behavioral reference only.

---

## Wave C — SSH `Transport` (this package)

| Task | Priority | Depends on | Scope | DoD |
| --- | --- | --- | --- | --- |
| **C0** | P0 | — | Confirm SDK `REQ-SDK-1` landed (`exports["./transport"]`). Wire `peerDependency` / path dep to workspace SDK. Remove any TEMP type mirror. | `import type { Transport } from '@jooservices/vigor3912s-sdk/transport'` typechecks |
| **C1** | P0 | C0 | Package surface: `SshTransport` class + options (`host`, `port`, `username`, `password`, `hostFingerprint`, `insecureSkipVerify?`, timeouts). Fail closed without fingerprint unless explicit skip (tests only). | Public types exported; unit tests for option validation |
| **C2** | P0 | C1 | Connect: `ssh2` client, password auth, **host-key verifier** (SHA256 pin). Map errors to stable codes. | Fake ssh2 tests: match pin → ready; mismatch → reject |
| **C3** | P0 | C2 | Interactive shell session: wait for `DrayTek> ` (or `#`) prompt; strip echo; handle `--- MORE ---` pager (space / max pages). | Fake stream tests for prompt + pager |
| **C4** | P0 | C3 | Implement `Transport`: `isOpen`, `send(frame, limits, signal)`, `close(reason)`. One CLI command per send; honor abort/timeout/output limits; no fabricated exit codes. | Contract tests vs SDK FakeTransport semantics |
| **C5** | P1 | C4 | Session hygiene: mutex/queue if required by shell; reconnect policy (document); idle cleanup. | Tests for serialize + close |
| **C6** | P2 | C5 | Docs: `docs/transport-impl.md`, `.env.example`, README usage snippet. Optional live smoke script behind explicit env flag. | Docs merged; no credentials in repo |

**Suggested order:** C0 → C1 → C2 → C3 → C4 → C5 → C6.

**Out of scope:** MCP adapter, SDK domain ops, live destructive writes.

---

## Parallelism note

Do **not** start C1 against a permanent forked `Transport` type. If SDK export is delayed, only a clearly marked `src/temp-sdk-transport.ts` (`TEMP: delete after C0`) is allowed — and C0 must delete it.
