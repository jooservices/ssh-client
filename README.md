# jooservices/ssh-client

[![CI](https://github.com/jooservices/ssh-client/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/jooservices/ssh-client/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/jooservices/ssh-client/badge)](https://securityscorecards.dev/viewer/?uri=github.com/jooservices/ssh-client)
[![Node](https://img.shields.io/badge/Node-24.21-blue.svg)](https://nodejs.org/)
[![GitHub Release](https://img.shields.io/github/v/release/jooservices/ssh-client?display_name=tag)](https://github.com/jooservices/ssh-client/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Node 24 **SSH client** library (TypeScript). Open a session, run commands on an
interactive shell, and read output. Works with any SSH server that exposes an
interactive shell: prompt detection is configurable and `--- MORE ---` pager
output is handled automatically.

## Status

**v1.1.0** — interactive-shell SSH client with host-key pinning, attempt isolation, and lossless command output.
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

- **Interactive shell** — `exec` writes one raw line (`command\r`) on a PTY
  shell. There is no exit code and no separate stderr. The first ready line
  that looks like a prompt is captured and later commands must repeat that
  exact line. `promptRegex`, when set, must match the whole line. Output keeps
  indentation, blank lines, and leading `#` / `>`. A `--- MORE ---` pager is
  space-scrolled up to `maxPages` (default 60).
- **Host-key pinning** — connections fail closed unless `hostFingerprint`
  (OpenSSH `SHA256:…` or hex form) is pinned and matched. `insecureSkipVerify`
  is a lab/test hatch only. `fingerprintSha256()` computes fingerprints.
- **Transport hygiene** — one ready budget covers handshake, shell open, and
  the first prompt. Disconnect rejects in-flight and queued `exec` with
  `closed`. A failed prompt resync closes the session. This library does not
  enable TCP keepalive and does not narrow ssh2 algorithms.

## Development

```bash
nvm use            # Node 24.21.0 (.nvmrc)
npm install
npm run lint       # tsc --noEmit
npm test           # vitest unit tests (fakes only, no live host)
npm run build      # emit dist/
npm run ci         # lint + test types + coverage (aggregate ≥90%, per file ≥85%) + build + consumer types
npm run test:e2e   # local and CI Docker Ubuntu sshd E2E — Docker daemon, OpenSSH client, openssl, Node 24.21
```

Full embedder + operator guide: [`docs/usage.md`](./docs/usage.md).

## Security

Host keys are pinned by default — set `hostFingerprint` for every non-test
connection. Keep credentials in a gitignored `.env`; template:
[`.env.example`](./.env.example). See [`SECURITY.md`](./SECURITY.md).

## License

MIT — see [`LICENSE`](LICENSE).
