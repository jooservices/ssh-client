# Implementation plan — ssh-client

**Product:** Standalone Node 24 / TypeScript SSH client library  
**Date:** 2026-09-14  
**Status:** Detailed plan (scaffold `v0.0.0` exists; implementation not started)  
**Scope rule:** This package is an SSH client only. It must not depend on, import, or document other application packages.

---

## 0. One-sentence goal

Provide `SshClient`: connect with password + host-key pin, run commands on an interactive shell, return cleaned output — usable by any Node app.

---

## 1. What / Why / How (product level)

| | |
| --- | --- |
| **What** | A small library: open SSH → interactive shell → `exec(command)` → string (or `{ stdout, durationMs }`) → disconnect. |
| **Why** | Many network appliances (including DrayOS on Vigor 3912S) only support an interactive shell over SSH (no reliable `exec` channel, often password-only). Apps need a shared, tested client instead of re-implementing prompt/pager/host-key each time. |
| **How** | Wrap `ssh2`: verify host key on connect; open a shell channel; write one command line; read until a prompt; handle `--- MORE ---`; serialize concurrent calls; expose a minimal public façade. |

### Non-goals (explicit)

| Not this package | Why |
| --- | --- |
| Router command catalogs / typed “WAN status” APIs | Belongs in higher-level libraries |
| AI tool / confirm / audit protocols | Belongs in application servers |
| SFTP, port-forward, agent forwarding | Out of v1 scope |
| SSH public-key auth | v1 = password only (extend later if needed) |

---

## 2. Target public API

### 2.1 Types

```ts
// --- errors ---
export type SshErrorCode =
  | 'connect'   // TCP / handshake / host-key failure
  | 'auth'      // bad credentials
  | 'timeout'   // ready or command timeout
  | 'closed'    // session/channel gone
  | 'invalid';  // bad options or empty command

export class SshClientError extends Error {
  readonly code: SshErrorCode;
  constructor(code: SshErrorCode, message: string) {
    super(message);
    this.name = 'SshClientError';
    this.code = code;
  }
}

// --- options ---
export interface SshClientOptions {
  host: string;
  port?: number;                 // default 22
  username: string;
  password: string;
  /** OpenSSH `SHA256:…` or 64-char hex. Required unless insecureSkipVerify. */
  hostFingerprint?: string;
  /** Lab/tests only. Default false. */
  insecureSkipVerify?: boolean;
  readyTimeoutMs?: number;       // default 20_000
  commandTimeoutMs?: number;     // default 15_000
  maxPages?: number;             // default 60
  settleMs?: number;             // default 150 — wait after prompt before resolving
  /** Optional override if firmware prompt differs. Default: /(?:>|#)\s*$/m */
  promptRegex?: RegExp;
}

export interface ExecOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  maxPages?: number;
}

export interface ExecResult {
  stdout: string;
  durationMs: number;
}
```

### 2.2 Class

```ts
export declare class SshClient {
  constructor(options: SshClientOptions);
  /** True when SSH + shell are ready for exec. */
  get connected(): boolean;
  /** Idempotent lazy connect (no-op if already connected). */
  connect(): Promise<void>;
  /**
   * Run one command on the interactive shell.
   * - Trims trailing prompt / strips echoed command line when possible.
   * - Serialized: concurrent exec() calls queue FIFO on this instance.
   */
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  /** Close shell + SSH. Safe to call multiple times. */
  disconnect(): Promise<void>;
}
```

### 2.3 Usage sketch

```ts
import { SshClient } from '@jooservices/ssh-client';

const client = new SshClient({
  host: process.env.SSH_HOST!,
  username: process.env.SSH_USER!,
  password: process.env.SSH_PASSWORD!,
  hostFingerprint: process.env.SSH_HOST_FINGERPRINT!,
});

await client.connect();
try {
  const { stdout } = await client.exec('sys version');
  console.log(stdout);
} finally {
  await client.disconnect();
}
```

---

## 3. Code structure (what each file is for)

```text
projects/ssh-client/
├── src/
│   ├── index.ts          # Public barrel (only stable exports)
│   ├── options.ts        # Defaults + validation → ResolvedOptions
│   ├── errors.ts         # SshClientError + codes
│   ├── host-key.ts       # Fingerprint format + constant-time compare
│   ├── client.ts         # SshClient façade (queue + delegates)
│   ├── session.ts        # ssh2 Client: connect, shell, teardown
│   ├── shell-io.ts       # Write command, accumulate until prompt
│   ├── pager.ts          # Detect MORE, send space, page budget
│   └── queue.ts          # Promise-chain mutex for exec
├── tests/
│   ├── support/
│   │   └── fake-ssh2.ts  # Scripted Client/Channel for unit tests
│   ├── options.test.ts
│   ├── host-key.test.ts
│   ├── pager.test.ts
│   ├── shell-io.test.ts
│   ├── session.test.ts
│   └── client.test.ts
├── docs/
│   └── usage.md          # Operator + embedder guide (phase C6)
├── IMPLEMENTATION-PLAN.md
├── BACKLOG.md
└── HANDOVER.md
```

| File | What | Why | How |
| --- | --- | --- | --- |
| `options.ts` | Normalize + validate config | Fail fast; one place for defaults | Pure functions; throw `SshClientError('invalid', …)` |
| `errors.ts` | Typed errors | Callers can `switch (err.code)` | Small Error subclass |
| `host-key.ts` | Pin verification | Stop MITM before auth completes | SHA256 OpenSSH form + hex; `timingSafeEqual` |
| `session.ts` | Lifecycle of ssh2 + shell stream | Isolate vendor API from façade | `connect()` / `getStream()` / `close()` |
| `shell-io.ts` | One command exchange | Core I/O loop | write `\r`, buffer on `data`, resolve on prompt |
| `pager.ts` | Page-through MORE | Long outputs on appliances | On MORE match → write ` ` ; cap pages |
| `queue.ts` | Serialize exec | One shell cannot interleave commands | FIFO promise chain |
| `client.ts` | Public API | Stable surface for consumers | Wire options → session → shell-io via queue |
| `fake-ssh2.ts` | Test double | CI without network | Script map `command → response body` |

---

## 4. Internal skeletons (implement against these)

### 4.1 `src/errors.ts`

```ts
export type SshErrorCode = 'connect' | 'auth' | 'timeout' | 'closed' | 'invalid';

export class SshClientError extends Error {
  readonly code: SshErrorCode;
  constructor(code: SshErrorCode, message: string) {
    super(message);
    this.name = 'SshClientError';
    this.code = code;
  }
}
```

### 4.2 `src/options.ts`

```ts
import { SshClientError } from './errors.js';
import type { SshClientOptions } from './index.js'; // or local types file

export interface ResolvedOptions {
  host: string;
  port: number;
  username: string;
  password: string;
  hostFingerprint: string | null;
  insecureSkipVerify: boolean;
  readyTimeoutMs: number;
  commandTimeoutMs: number;
  maxPages: number;
  settleMs: number;
  promptRegex: RegExp;
}

const DEFAULTS = {
  port: 22,
  readyTimeoutMs: 20_000,
  commandTimeoutMs: 15_000,
  maxPages: 60,
  settleMs: 150,
  promptRegex: /(?:>|#)\s*$/m,
} as const;

export function resolveOptions(input: SshClientOptions): ResolvedOptions {
  if (!input.host?.trim()) throw new SshClientError('invalid', 'host is required');
  if (!input.username?.trim()) throw new SshClientError('invalid', 'username is required');
  if (!input.password) throw new SshClientError('invalid', 'password is required');

  const insecureSkipVerify = input.insecureSkipVerify === true;
  const hostFingerprint = input.hostFingerprint?.trim() || null;
  if (!insecureSkipVerify && !hostFingerprint) {
    throw new SshClientError(
      'invalid',
      'hostFingerprint is required unless insecureSkipVerify is true',
    );
  }

  return {
    host: input.host.trim(),
    port: input.port ?? DEFAULTS.port,
    username: input.username.trim(),
    password: input.password,
    hostFingerprint,
    insecureSkipVerify,
    readyTimeoutMs: input.readyTimeoutMs ?? DEFAULTS.readyTimeoutMs,
    commandTimeoutMs: input.commandTimeoutMs ?? DEFAULTS.commandTimeoutMs,
    maxPages: input.maxPages ?? DEFAULTS.maxPages,
    settleMs: input.settleMs ?? DEFAULTS.settleMs,
    promptRegex: input.promptRegex ?? DEFAULTS.promptRegex,
  };
}
```

### 4.3 `src/host-key.ts`

```ts
import { createHash, timingSafeEqual } from 'node:crypto';

/** OpenSSH-style fingerprint: `SHA256:` + unpadded base64. */
export function fingerprintSha256(hostKey: Buffer): string {
  const b64 = createHash('sha256').update(hostKey).digest('base64').replace(/=+$/u, '');
  return `SHA256:${b64}`;
}

function normalize(expected: string): string {
  const t = expected.trim();
  if (/^sha256:/iu.test(t)) {
    return `SHA256:${t.slice(t.indexOf(':') + 1).replace(/=+$/u, '')}`;
  }
  if (/^[0-9a-f]{64}$/iu.test(t)) {
    const b64 = Buffer.from(t, 'hex').toString('base64').replace(/=+$/u, '');
    return `SHA256:${b64}`;
  }
  return t;
}

export function hostKeyMatches(expectedFingerprint: string, hostKey: Buffer): boolean {
  const a = Buffer.from(normalize(expectedFingerprint));
  const b = Buffer.from(normalize(fingerprintSha256(hostKey)));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
```

### 4.4 `src/queue.ts`

```ts
/** Serialize async work on one chain (one in-flight task at a time). */
export function createQueue(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = tail.then(fn, fn);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}
```

### 4.5 `src/pager.ts`

```ts
const MORE_RE = /---\s*MORE\s*---/i;

export interface PagerState {
  pages: number;
}

/**
 * If buffer ends with a MORE marker, write a space to the stream and bump pages.
 * Throws if maxPages exceeded.
 */
export function handlePagerIfNeeded(
  buf: string,
  stream: { write: (data: string) => void },
  state: PagerState,
  maxPages: number,
): string {
  if (!MORE_RE.test(buf)) return buf;
  if (state.pages >= maxPages) {
    throw new Error(`pager exceeded maxPages=${maxPages}`);
  }
  state.pages += 1;
  stream.write(' ');
  // Drop MORE marker from buffer so we do not loop forever on same match.
  return buf.replace(MORE_RE, '');
}
```

### 4.6 `src/shell-io.ts` (skeleton)

```ts
import type { ResolvedOptions } from './options.js';
import { SshClientError } from './errors.js';
import { handlePagerIfNeeded, type PagerState } from './pager.js';

export interface ShellStream {
  write: (data: string) => void;
  on: (event: 'data', cb: (chunk: Buffer) => void) => void;
  removeListener: (event: 'data', cb: (chunk: Buffer) => void) => void;
}

/**
 * Write one command, read until prompt (with pager + timeout + abort).
 * Returns cleaned stdout (echo line stripped when present).
 */
export function runCommandOnShell(
  stream: ShellStream,
  command: string,
  opts: Pick<ResolvedOptions, 'promptRegex' | 'settleMs' | 'commandTimeoutMs' | 'maxPages'>,
  overrides?: { timeoutMs?: number; signal?: AbortSignal; maxPages?: number },
): Promise<string> {
  const timeoutMs = overrides?.timeoutMs ?? opts.commandTimeoutMs;
  const maxPages = overrides?.maxPages ?? opts.maxPages;
  const signal = overrides?.signal;

  return new Promise<string>((resolve, reject) => {
    let buf = '';
    const pager: PagerState = { pages: 0 };
    let settleTimer: ReturnType<typeof setTimeout> | null = null;

    const onData = (chunk: Buffer): void => {
      buf += chunk.toString('utf8');
      try {
        buf = handlePagerIfNeeded(buf, stream, pager, maxPages);
      } catch (e) {
        cleanup();
        reject(e);
        return;
      }
      if (opts.promptRegex.test(buf)) {
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(() => {
          cleanup();
          resolve(cleanOutput(buf, command));
        }, opts.settleMs);
      }
    };

    const cleanup = (): void => {
      stream.removeListener('data', onData);
      clearTimeout(timer);
      if (settleTimer) clearTimeout(settleTimer);
      signal?.removeEventListener('abort', onAbort);
    };

    const onAbort = (): void => {
      cleanup();
      reject(new SshClientError('closed', 'aborted'));
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new SshClientError('timeout', `command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    signal?.addEventListener('abort', onAbort, { once: true });
    stream.on('data', onData);
    stream.write(`${command}\r`);
  });
}

function cleanOutput(raw: string, command: string): string {
  // Strip echoed command line and trailing prompt — refine in C3 with fixtures.
  let s = raw.replace(/\r\n/g, '\n');
  const lines = s.split('\n');
  if (lines[0]?.includes(command)) lines.shift();
  // Drop last line if it looks like a prompt
  if (lines.length && /(?:>|#)\s*$/.test(lines[lines.length - 1]!)) lines.pop();
  return lines.join('\n').trim();
}
```

### 4.7 `src/session.ts` (skeleton)

```ts
import { Client, type ClientChannel } from 'ssh2';
import type { ResolvedOptions } from './options.js';
import { SshClientError } from './errors.js';
import { hostKeyMatches } from './host-key.js';

export class SshSession {
  private client: Client | null = null;
  private stream: ClientChannel | null = null;

  constructor(private readonly opts: ResolvedOptions) {}

  get isOpen(): boolean {
    return this.client !== null && this.stream !== null;
  }

  async connect(): Promise<void> {
    if (this.isOpen) return;
    const client = new Client();
    await new Promise<void>((resolve, reject) => {
      const fail = (code: 'connect' | 'auth' | 'timeout', msg: string): void => {
        client.end();
        reject(new SshClientError(code, msg));
      };

      client
        .on('ready', () => {
          client.shell((err, stream) => {
            if (err || !stream) {
              fail('connect', err?.message ?? 'shell failed');
              return;
            }
            this.client = client;
            this.stream = stream;
            // Wait for initial prompt before resolve — implemented in C3.
            resolve();
          });
        })
        .on('error', (err) => {
          const msg = err.message ?? String(err);
          fail(/auth|password/i.test(msg) ? 'auth' : 'connect', msg);
        })
        .connect({
          host: this.opts.host,
          port: this.opts.port,
          username: this.opts.username,
          password: this.opts.password,
          readyTimeout: this.opts.readyTimeoutMs,
          ...(this.opts.insecureSkipVerify
            ? {}
            : {
                hostVerifier: (key: Buffer): boolean =>
                  hostKeyMatches(this.opts.hostFingerprint!, key),
              }),
        });
    });
  }

  getStream(): ClientChannel {
    if (!this.stream) throw new SshClientError('closed', 'not connected');
    return this.stream;
  }

  async disconnect(): Promise<void> {
    this.stream?.close();
    this.client?.end();
    this.stream = null;
    this.client = null;
  }
}
```

### 4.8 `src/client.ts` (skeleton)

```ts
import type { ExecOptions, ExecResult, SshClientOptions } from './public-types.js';
import { resolveOptions } from './options.js';
import { SshSession } from './session.js';
import { runCommandOnShell } from './shell-io.js';
import { createQueue } from './queue.js';
import { SshClientError } from './errors.js';

export class SshClient {
  private readonly opts;
  private readonly session: SshSession;
  private readonly enqueue = createQueue();

  constructor(options: SshClientOptions) {
    this.opts = resolveOptions(options);
    this.session = new SshSession(this.opts);
  }

  get connected(): boolean {
    return this.session.isOpen;
  }

  connect(): Promise<void> {
    return this.session.connect();
  }

  exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    const cmd = command.trim();
    if (!cmd) return Promise.reject(new SshClientError('invalid', 'command is empty'));

    return this.enqueue(async () => {
      if (!this.session.isOpen) await this.session.connect();
      const started = Date.now();
      const stdout = await runCommandOnShell(this.session.getStream(), cmd, this.opts, options);
      return { stdout, durationMs: Date.now() - started };
    });
  }

  disconnect(): Promise<void> {
    return this.session.disconnect();
  }
}
```

### 4.9 `src/index.ts` (barrel)

```ts
export { SshClient } from './client.js';
export { SshClientError, type SshErrorCode } from './errors.js';
export type { SshClientOptions, ExecOptions, ExecResult } from './public-types.js';
export { fingerprintSha256 } from './host-key.js';
```

---

## 5. Phase plan (What / Why / How per task)

### C1 — Options & errors

| | |
| --- | --- |
| **What** | `errors.ts`, `options.ts`, `public-types.ts`; unit tests for validation matrix. |
| **Why** | Every later module needs one validated config object and stable error codes. |
| **How** | Pure validate; table-driven tests (missing host, missing fingerprint, skip verify, defaults). |
| **Files** | `src/errors.ts`, `src/options.ts`, `src/public-types.ts`, `tests/options.test.ts` |
| **DoD** | Invalid combos throw `invalid`; happy path returns `ResolvedOptions`. |

### C2 — Connect + host key

| | |
| --- | --- |
| **What** | `host-key.ts` + `session.connect()` with `hostVerifier`. |
| **Why** | Without pinning, password auth is MITM-able on LAN. |
| **How** | Inject/mock `ssh2.Client` in tests; real `ssh2` in production path. |
| **Files** | `src/host-key.ts`, `src/session.ts` (connect only), `tests/host-key.test.ts`, `tests/session.test.ts`, `tests/support/fake-ssh2.ts` |
| **DoD** | Match pin → ready; mismatch → `connect` error; bad password → `auth`. |

### C3 — Interactive shell I/O

| | |
| --- | --- |
| **What** | Wait for banner prompt after connect; `shell-io` + `pager`. |
| **Why** | Appliance CLIs are line-oriented shells with MORE pagers, not `exec` channels. |
| **How** | Fake channel emits scripted chunks; assert clean stdout and page count. |
| **Files** | `src/shell-io.ts`, `src/pager.ts`, `tests/shell-io.test.ts`, `tests/pager.test.ts` |
| **DoD** | Prompt detect, echo strip, MORE advances, maxPages throws timeout/invalid. |

### C4 — Public `SshClient`

| | |
| --- | --- |
| **What** | Façade + queue; `connect` / `exec` / `disconnect`. |
| **Why** | Consumers need one class, not internal modules. |
| **How** | Wire C1–C3; concurrent `exec` proofs FIFO. |
| **Files** | `src/client.ts`, `src/queue.ts`, `src/index.ts`, `tests/client.test.ts` |
| **DoD** | Full fake e2e: connect → exec → exec → disconnect; abort/timeout covered. |

### C5 — Hardening

| | |
| --- | --- |
| **What** | Idle buffer cap; exec-after-close; double disconnect; document reconnect (v1: call `connect()` again after `disconnect()`). |
| **Why** | Prevent hangs and leaks in long-running embedders. |
| **How** | Extra tests + short “Session lifecycle” section in docs. |
| **DoD** | No throw on double disconnect; exec when closed auto-reconnect **or** clear `closed` error (pick one in C5 and document — recommend **auto-reconnect on exec** to match lazy connect). |

### C6 — Docs & optional live smoke

| | |
| --- | --- |
| **What** | `docs/usage.md`, README example, `.env.example`, optional `tools/live-smoke.mjs`. |
| **Why** | Embedders need copy-paste setup; live proof stays manual. |
| **How** | Smoke reads env; refuses to run without fingerprint; not invoked from `npm test`. |
| **DoD** | Docs accurate; smoke documented as opt-in. |

---

## 6. PR slicing

| PR | Contains | Merge criteria |
| --- | --- | --- |
| **PR1** | C1 + C2 | `npm run ci` green; host-key tests pass |
| **PR2** | C3 + C4 | Fake e2e client tests pass |
| **PR3** | C5 + C6 | Docs + hardening tests |

Branch from local `develop`. Push/GitHub only when asked.

---

## 7. Test matrix (minimum)

| Case | Expected |
| --- | --- |
| Options: no fingerprint, skip false | `invalid` |
| Options: skip true | OK |
| Host key mismatch | `connect` |
| Auth failure | `auth` |
| Simple exec | stdout without echo/prompt |
| Paged exec | full body, pages ≤ max |
| Timeout | `timeout` |
| AbortSignal | `closed` or abort error mapped |
| Parallel exec | ordered results, no interleaved buffer corruption |
| Double disconnect | no throw |

---

## 8. Definition of Done — v0.1.0 candidate

- [ ] C1–C4 merged; `npm run ci` green  
- [ ] Public exports: `SshClient`, `SshClientError`, options/result types, `fingerprintSha256` helper  
- [ ] README usage matches API  
- [ ] No secrets in repo  
- [ ] CHANGELOG notes first functional release when version bumps  

---

## 9. Decision log (plan-time)

| Decision | Choice | Rationale |
| --- | --- | --- |
| Shell vs exec channel | **Shell** | Appliance compatibility |
| Auth v1 | **Password** | Matches common appliance setup |
| Host key | **Required** (skip only for tests) | Security default |
| Concurrent exec | **Queue** | Single shell stream |
| Exit codes | **None** | Shell sessions do not give reliable remote exit status |
| Package coupling | **None** | Generic client for any consumer |

---

## 10. Next action

Start **C1** on branch `feature/ssh-client-options-errors`: add `public-types.ts`, `errors.ts`, `options.ts` + tests — no `ssh2` connect yet.
