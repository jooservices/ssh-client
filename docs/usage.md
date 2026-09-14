# Using `@jooservices/ssh-client`

Guide for **embedders** (calling `SshClient` from Node code) and **operators**
(connecting to real hosts). Every statement here matches the implemented API
in `src/`. Requirements: Node `>=24.21.0 <25`, ESM. JS + type declarations are
emitted to `dist/` and exposed through the package `exports` map.

The package is **`"private": true`** (not on npm). Consume it from this checkout
(`file:` / workspace path) or from a Git dependency on a tagged release.

```bash
npm install
npm run build
```

## Public API

`src/index.ts` exports: `SshClient`, `SshClientError`, `SshErrorCode`,
`fingerprintSha256`, and the types `SshClientOptions`, `ExecOptions`,
`ExecResult`.

```ts
import { SshClient, SshClientError, type ExecResult } from '@jooservices/ssh-client';

const client = new SshClient({
  host: '192.168.1.1',
  username: 'admin',
  password: process.env.SSH_PASSWORD!,
  hostFingerprint: 'SHA256:…',
});

await client.connect();          // opens TCP + auth + shell, waits for first prompt
const result: ExecResult = await client.exec('sys version');
console.log(result.stdout, result.durationMs, result.connectMs);
await client.disconnect();       // safe to call twice
console.log(client.connected);   // boolean getter
```

The constructor validates options synchronously and throws
`SshClientError('invalid', …)` on bad input (see Options below). Numeric
options are range-checked (e.g. `port` 1–65535, timeouts 1–600000 ms).

## Client options (`SshClientOptions`)

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `host` | `string` | — | **required** (trimmed) |
| `port` | `number` | `22` | integer 1–65535 |
| `username` | `string` | — | **required** (trimmed) |
| `password` | `string` | — | **required**, non-empty (password auth only) |
| `hostFingerprint` | `string` | — | **required** unless `insecureSkipVerify`; `SHA256:…` or 64-char hex |
| `insecureSkipVerify` | `boolean` | `false` | skips host-key check — tests only |
| `readyTimeoutMs` | `number` | `20000` | connect + first prompt budget |
| `commandTimeoutMs` | `number` | `15000` | per-`exec` default timeout |
| `maxPages` | `number` | `60` | pager page cap per command |
| `settleMs` | `number` | `150` | quiet time after prompt match before resolving |
| `promptRegex` | `RegExp` | `/(?:>|#)\s*$/m` | shell prompt matcher |
| `maxOutputBytes` | `number` | `8388608` (8 MiB) | output buffer cap per command |
| `term` / `rows` / `cols` | PTY | `vt100` / `200` / `200` | interactive shell window |
| `idleBufferMaxBytes` | `number` | `65536` | unsolicited data cap between commands |

## `exec(command, options?)`

Returns `Promise<ExecResult>`:

| Field | Meaning |
| --- | --- |
| `stdout` | Cleaned output: CRLF/CR → `\n`, echoed command and trailing prompt removed |
| `durationMs` | Wall time from command write to prompt settle |
| `sendAt` | Epoch ms when the command was written |
| `recvAt` | Epoch ms when the response settled |
| `connectMs` | Ms spent connecting/reconnecting before this command (`0` if already up) |

Per-call `ExecOptions` (each falls back to the client value where applicable):

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `timeoutMs` | `number` | client `commandTimeoutMs` | reject with `timeout` when exceeded |
| `idleTimeoutMs` | `number` | — | reject with `timeout` if no new output for this many ms |
| `signal` | `AbortSignal` | — | abort rejects with `closed` (also when already aborted) |
| `maxPages` | `number` | client `maxPages` | pager cap for this command |
| `maxOutputBytes` | `number` | client cap | output cap for this command |

Behavioral guarantees:

- An empty/whitespace-only command rejects with `invalid`.
- Commands are **serialized** on the single shell session — concurrent `exec`
  calls on one client are queued, one command ↔ one response.
- `exec` **auto-reconnects**: if the session is closed (first call, after
  `disconnect()`, or after a drop), it connects before running the command.
- `disconnect()` during an in-flight `connect()` leaves the session closed
  (no half-open session).
- A failed `stream.write` for the command clears the in-flight waiter so the
  next `exec` is not stuck “already in flight”.
- After a command timeout, a best-effort prompt resync runs; the next command
  drops any leftover resync waiter and clears buffered output before starting.

## Error codes (`SshClientError.code`)

`SshClientError` (exported) extends `Error` with a stable `code`:
`'connect' | 'auth' | 'timeout' | 'closed' | 'invalid'`.

| Code | When it fires |
| --- | --- |
| `invalid` | constructor validation (missing identity fields, missing fingerprint without skip, out-of-range numeric options); empty `exec` command; output exceeded `maxOutputBytes` |
| `connect` | SSH handshake failed (host unreachable, TCP refused) **or pinned host key did not match**; shell channel open failed; disconnect during connect |
| `auth` | handshake error indicating an authentication/credential problem |
| `timeout` | ready prompt not seen within `readyTimeoutMs`; command did not settle within `timeoutMs`/`commandTimeoutMs`; idle gap exceeded `idleTimeoutMs`; pager exceeded `maxPages` |
| `closed` | `exec` aborted via `AbortSignal`; channel closed mid-command |

```ts
try {
  await client.exec('sys restart');
} catch (err) {
  if (err instanceof SshClientError) {
    // err.code: 'connect' | 'auth' | 'timeout' | 'closed' | 'invalid'
  }
}
```

## Host-key pinning

Connections **fail closed**: without a matching `hostFingerprint`, the client
never trusts the host (`connect` error, no commands run). `insecureSkipVerify`
disables the check and must only be used against test/simulated hosts.

```bash
ssh-keyscan -t ed25519 192.168.1.1 > /tmp/hostkey.pub
ssh-keygen -lf /tmp/hostkey.pub
# 256 SHA256:3wP2w… root@host (ED25519)
```

Pin the `SHA256:…` token as `hostFingerprint`. Comparison is constant-time and
also accepts the bare 64-hex-digit form:

```ts
import { fingerprintSha256 } from '@jooservices/ssh-client';

const fp = fingerprintSha256(rawHostKeyBuffer); // "SHA256:…"
```

## Environment / `.env` template

Operators configure live targets through `SSH_*` environment variables (copy
[`.env.example`](../.env.example), gitignored — **never commit real values**):

```bash
SSH_HOST=192.168.1.1
SSH_PORT=22
SSH_USER=admin
SSH_PASSWORD=
# Required for live connect (OpenSSH SHA256:… or hex):
# SSH_HOST_FINGERPRINT=SHA256:xxxxxxxx
# Tests / simulated hosts only:
# SSH_INSECURE_SKIP_VERIFY=true
```

The library itself reads no environment — it takes explicit options. The
`SSH_*` names are consumed by the opt-in live smoke (below) and by the Docker
E2E runner.

## Timeouts and abort

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(), 3_000);

const { stdout } = await client.exec('sys config show', {
  timeoutMs: 5_000,          // SshClientError 'timeout' if exceeded
  idleTimeoutMs: 2_000,      // timeout if no new bytes for 2s
  signal: controller.signal, // SshClientError 'closed' on abort
});
```

## Output cap and pager

Shell output accumulates in memory; exceeding `maxOutputBytes` (default 8 MiB)
rejects with `invalid` and abandons the command. A `--- MORE ---` pager prompt
is space-scrolled automatically up to `maxPages` (default 60) pages; exceeding
the cap rejects with `timeout`. For non-`>`/`#` prompts (e.g. bash `$` in the
E2E container), pass a custom `promptRegex` — as in `e2e/client.e2e.test.ts`:
`/(?:[>#$])\s*$/m`.

## Live smoke (opt-in)

A manual smoke against a real host. Requires a built `dist/` and pinned
credentials; it refuses to run without `SSH_HOST_FINGERPRINT` unless
`SSH_INSECURE_SKIP_VERIFY=true`. It is **not** referenced by any test suite.

```bash
npm run build
set -a; . ./.env; set +a
node tools/live-smoke.mjs
```

On success it prints the `exec` result JSON; on failure it prints the
`SshClientError` code and exits non-zero.

## Docker Ubuntu E2E

```bash
npm run test:e2e   # requires Docker, OpenSSH client tools, openssl
```

`tools/e2e.sh` builds the package, builds `docker/Dockerfile` (Ubuntu 24.04 +
`sshd`, user `tester`), starts a throwaway container on a random loopback port
with a generated password, captures the host fingerprint via `ssh-keyscan` +
`ssh-keygen`, exports the `SSH_*` environment, and runs
`vitest --config vitest.e2e.config.ts` over `e2e/`. The container is removed on
exit. E2E specs never run under `npm test`/`npm run ci`; GitHub Actions runs
them in a separate `e2e` job on the Node CI workflow.
