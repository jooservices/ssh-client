# vigor3912s-client — Implementation backlog

**Status:** Scaffold. Client-only SSH library.  
**Gate when coding:** `npm run ci` (lint + test + build).  
**Detailed plan (what / why / how + skeletons):** [`IMPLEMENTATION-PLAN.md`](./IMPLEMENTATION-PLAN.md).

---

## Wave C — SSH client

| Task | Priority | Scope | DoD |
| --- | --- | --- | --- |
| **C1** | P0 | **Options & errors** — `SshClientOptions` (host, port, username, password, hostFingerprint, insecureSkipVerify?, timeouts, maxPages). Fail closed without fingerprint unless explicit skip (tests only). Stable error codes (`connect`, `auth`, `timeout`, `closed`, `invalid`, …). | Validation tests; exported types |
| **C2** | P0 | **Connect** — `ssh2` password auth + **host-key pin** (SHA256). Reject mismatch before trusting the host. | Fake-ssh2: match → ready; mismatch → error |
| **C3** | P0 | **Interactive shell** — open shell channel; wait for prompt (`>` / `#`, DrayOS often `DrayTek> `); strip command echo; handle `--- MORE ---` pager. | Fake stream tests for prompt + pager |
| **C4** | P0 | **Public client API** — e.g. `connect()`, `exec(command, opts?) → string` (or structured result with stdout/timing), `disconnect()`, `isConnected`. Serialize concurrent exec on one session. Honor timeout / abort. | Unit tests on fake session; one command ↔ one response |
| **C5** | P1 | **Session hygiene** — reconnect policy (document), idle/buffer caps, clean teardown. | Tests for close + serialize |
| **C6** | P2 | **Docs** — README usage, `docs/usage.md`, `.env.example`. Optional live smoke script behind explicit flag (no credentials in repo). | Docs merged |

**Order:** C1 → C2 → C3 → C4 → C5 → C6.

## Out of scope

- Any other JOOservices application’s APIs, tools, or confirm/audit layers
- Shipping a router command catalog inside this package

## Code structure (target)

```text
src/
  index.ts           # public exports
  options.ts         # SshClientOptions + parse/validate
  errors.ts          # SshClientError + codes
  host-key.ts        # fingerprint helpers
  client.ts          # SshClient (public façade)
  session.ts         # ssh2 connect + shell lifecycle
  shell-io.ts        # write command, read until prompt
  pager.ts           # --- MORE ---
  queue.ts           # serialize exec on one shell
tests/
  support/fake-ssh2.ts
  options.test.ts
  host-key.test.ts
  client.test.ts
  shell-io.test.ts
  pager.test.ts
docs/
  usage.md
```
