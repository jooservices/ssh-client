# jooservices/ssh-client

[![CI](https://github.com/jooservices/ssh-client/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/jooservices/ssh-client/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/Node-24.21-blue.svg)](https://nodejs.org/)
[![GitHub Release](https://img.shields.io/github/v/release/jooservices/ssh-client?display_name=tag)](https://github.com/jooservices/ssh-client/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Node 24 **SSH client** library (TypeScript). Open a session, run commands on an
interactive shell, and read output. Works with any SSH server that exposes an
interactive shell: prompt detection is configurable and `--- MORE ---` pager
output is handled automatically.

## Status

**v1.0.0** — stable interactive-shell SSH client API with host-key pinning.
The package stays private (`"private": true`) and is not published to npm;
consume it from the checkout or a Git tag. See [`CHANGELOG.md`](./CHANGELOG.md).

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
const { stdout, durationMs, sendAt, recvAt, connectMs } = await client.exec('sys version');
await client.disconnect();
```

`exec()` returns `{ stdout, durationMs, sendAt, recvAt, connectMs }`, accepts
`{ timeoutMs, idleTimeoutMs, signal, maxPages, maxOutputBytes }`, auto-reconnects
if the session was dropped, and serializes concurrent commands on one shell.
Disconnecting twice is safe.

## Highlights

- **Interactive shell** — commands run on a real shell channel: write
  `command\r`, read until the prompt (`promptRegex`, default `/(?:>|#)\s*$/m`),
  strip the echoed command and trailing prompt, and drive the
  `--- MORE ---` pager (space-scrolled, capped by `maxPages`, default 60).
- **Host-key pinning** — connections fail closed unless `hostFingerprint`
  (OpenSSH `SHA256:…` or hex form) is pinned and matched; `insecureSkipVerify`
  is for tests only. `fingerprintSha256()` is exported to compute fingerprints.
- **Transport hygiene** — command write failures clear waiters; timeout resync
  does not poison the next command; disconnect during connect stays closed;
  optional per-command `idleTimeoutMs`.

## Development

```bash
nvm use            # Node 24.21.0 (.nvmrc)
npm install
npm run lint       # tsc --noEmit
npm test           # vitest unit tests (fakes only, no live host)
npm run build      # emit dist/
npm run ci         # lint + coverage (≥90%) + build
npm run test:e2e   # Docker Ubuntu sshd E2E — requires Docker
```

Full embedder + operator guide: [`docs/usage.md`](./docs/usage.md).

## Security

Host keys are pinned by default — set `hostFingerprint` for every non-test
connection. Keep credentials in a gitignored `.env`; template:
[`.env.example`](./.env.example). See [`SECURITY.md`](./SECURITY.md).

## License

MIT — see [`LICENSE`](LICENSE).
