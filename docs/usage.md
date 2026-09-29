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
| `insecureSkipVerify` | `boolean` | `false` | lab/test hatch; skips host-key check |
| `readyTimeoutMs` | `number` | `20000` | one budget for handshake, shell open, and the first prompt |
| `commandTimeoutMs` | `number` | `15000` | per-`exec` default timeout |
| `maxPages` | `number` | `60` | pager page cap per command |
| `settleMs` | `number` | `150` | quiet time after prompt match before resolving |
| `promptRegex` | `RegExp` | unset | optional full-line matcher; omit it to use the captured ready line |
| `maxOutputBytes` | `number` | `8388608` (8 MiB) | cap for ready banner and for each command |
| `term` / `rows` / `cols` | PTY | `vt100` / `200` / `200` | interactive shell window |
| `idleBufferMaxBytes` | `number` | `65536` | unsolicited data cap between commands |

## `exec(command, options?)`

Returns `Promise<ExecResult>`:

| Field | Meaning |
| --- | --- |
| `stdout` | Shell text after the normalizations below. Failures reject and do not return this object |
| `durationMs` | Wall time from command write to prompt settle |
| `sendAt` | Epoch ms when the command was written |
| `recvAt` | Epoch ms when the response settled |
| `connectMs` | Ms spent connecting/reconnecting before this command (`0` if already up) |

Per-call `ExecOptions` (each falls back to the client value where applicable):

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `timeoutMs` | `number` | client `commandTimeoutMs` | integer 1–600000; may be higher than the instance default |
| `idleTimeoutMs` | `number` | disabled | `0` or omitted disables; otherwise integer 1–600000 |
| `signal` | `AbortSignal` | — | abort rejects with `closed` (also when already aborted) |
| `maxPages` | `number` | client `maxPages` | integer 1..instance `maxPages` |
| `maxOutputBytes` | `number` | client cap | integer 1..instance `maxOutputBytes` |

`exec` writes the command as one raw shell line. It does not shell-escape,
does not collect an exit code, and does not split stderr. The caller owns
whatever the remote shell does with that line.

Invalid `ExecOptions` reject with `invalid` before connect or write. An
already-aborted signal is checked after that validation.

Behavioral guarantees:

- An empty/whitespace-only command rejects with `invalid`.
- Commands are **serialized** on the single shell session — concurrent `exec`
  calls on one client are queued, one command ↔ one response.
- `exec` connects when the session is down, including the first call and a
  call that starts after `disconnect()` has resolved.
- Output bytes are counted as raw chunk length. A multibyte character that
  crosses `maxOutputBytes` rejects with `invalid`.

### Disconnect

| Call | Result |
| --- | --- |
| `exec` already running | rejects `closed`; the session is torn down |
| `exec` already queued | rejects `closed`; it does not connect or write |
| `exec` / `connect` while `disconnect()` is in progress | rejects `closed` immediately |
| `exec` / `connect` after `disconnect()` resolves | may open a new session |

`disconnect()` itself is idempotent.

### Prompt and stdout

Ready waits for one line that contains a non-space and ends with `>`, `#`,
`$`, or `%` (trailing spaces allowed). That exact line, including trailing
spaces, becomes the prompt identity. Command completion uses that identity.
`promptRegex`, when set, replaces the identity for both ready and commands and
must cover the entire current line (`index === 0` and the match length equals
the line). A line that merely ends with `#` or `>` does not finish a command.

Stdout normalization, and nothing else:

- `\r\n` and a lone `\r` become `\n`. This is not a terminal emulator: a bare
  CR does not erase the line.
- The substring `--- MORE ---` is removed.
- The final prompt line is removed.
- The first line is removed when it is the echoed command (the line equals the
  command, or it ends with the command and the prefix is the prompt).
- Later copies of the command, blank lines, indentation, and leading `#` / `>`
  stay. The result is not trimmed.

### Timeouts

`readyTimeoutMs` is a single deadline from `connect()` through the handshake,
authentication, shell open, and the first prompt. Later phases receive only
the time still left. A handshake error whose message says it timed out is
`timeout`. Host-key mismatch stays `connect`.

A command timeout writes `q` when a pager was active, otherwise a bare CR, and
waits up to 5 seconds for the prompt. Success keeps the session. Failure
closes it so the next allowed `exec` can connect again. There is no TCP
keepalive setting and no algorithm allowlist; ssh2 defaults stay in place.

## Error codes (`SshClientError.code`)

`SshClientError` (exported) extends `Error` with a stable `code`:
`'connect' | 'auth' | 'timeout' | 'closed' | 'invalid'`.

| Code | When it fires |
| --- | --- |
| `invalid` | constructor or `ExecOptions` validation; empty `exec` command; ready or command output exceeded `maxOutputBytes` |
| `connect` | handshake failed, pinned host key did not match, shell open failed, or the channel died before ready |
| `auth` | handshake error indicating an authentication/credential problem |
| `timeout` | handshake reported a timeout; ready budget exhausted; command, idle, or pager cap exceeded |
| `closed` | abort; disconnect barrier; channel or client failure after ready |

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
is a lab and test hatch only.

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

Shell output accumulates in memory. Ready banner bytes and command bytes
share the instance `maxOutputBytes` (default 8 MiB). Exceeding it rejects with
`invalid` and closes the session. A `--- MORE ---` pager is space-scrolled up
to `maxPages` (default 60); the next prompt after the cap rejects with
`timeout`. Bash prompts such as `user@host:~$ ` are captured as-is when
`promptRegex` is omitted. Set `promptRegex` only when the prompt changes, and
make it match the entire line.

## Live smoke (opt-in)

A manual smoke against a real host. Requires a built `dist/` and pinned
credentials; it refuses to run without `SSH_HOST_FINGERPRINT` unless
`SSH_INSECURE_SKIP_VERIFY=true`. It is **not** part of `npm test` or CI.
Unit tests use fakes. Docker E2E is opt-in via `npm run test:e2e`.

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
