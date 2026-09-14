# jooservices/ssh-client

[![CI](https://github.com/jooservices/ssh-client/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/jooservices/ssh-client/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/Node-24%2B-blue.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Node 24 **SSH client** library (TypeScript). Open a session, run commands on an
interactive shell, read output. Tuned for DrayOS-style prompts and pagers on
Vigor 3912S, usable as a general SSH exec helper from any Node app.

## Status

**Implemented** — v0.1.0 candidate (release, version bump, and publish not yet
done). Tasks C1–C7 in [`BACKLOG.md`](./BACKLOG.md) are complete; see
[`CHANGELOG.md`](./CHANGELOG.md) and [`HANDOVER.md`](./HANDOVER.md).

## Usage

```ts
import { SshClient } from '@jooservices/ssh-client';

const client = new SshClient({
  host: '192.168.1.1',
  port: 22,
  username: 'admin',
  password: '…', // keep real credentials in a gitignored .env
  hostFingerprint: 'SHA256:…', // required unless insecureSkipVerify (tests only)
});

await client.connect();
const { stdout, durationMs } = await client.exec('sys version');
await client.disconnect();
```

`exec()` returns `{ stdout, durationMs }`, accepts
`{ timeoutMs, signal, maxPages, maxOutputBytes }`, auto-reconnects if the
session was dropped, and serializes concurrent commands on one shell.
Disconnecting twice is safe.

## Highlights

- **Interactive shell** — commands run on a real shell channel: write
  `command\r`, read until the prompt (`promptRegex`, default `/(?:>|#)\s*$/m`),
  strip the echoed command and trailing prompt, and drive the
  `--- MORE ---` pager (space-scrolled, capped by `maxPages`, default 60).
- **Host-key pinning** — connections fail closed unless `hostFingerprint`
  (OpenSSH `SHA256:…` or hex form) is pinned and matched; `insecureSkipVerify`
  is for tests only. `fingerprintSha256()` is exported to compute fingerprints.

## Development

```bash
nvm use            # Node 24
npm install
npm run lint       # tsc --noEmit
npm test           # vitest unit tests (fakes only, no live host)
npm run build      # emit dist/
npm run ci         # lint + test + build
npm run test:e2e   # Docker Ubuntu sshd E2E — requires Docker
```

Full embedder + operator guide: [`docs/usage.md`](./docs/usage.md).

## Security

Host keys are pinned by default — set `hostFingerprint` for every non-test
connection. Keep credentials in a gitignored `.env`; template:
[`.env.example`](./.env.example). See [`SECURITY.md`](./SECURITY.md).

## License

MIT — see [`LICENSE`](LICENSE).
