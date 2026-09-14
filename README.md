# jooservices/ssh-client

[![CI](https://github.com/jooservices/ssh-client/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/jooservices/ssh-client/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/Node-24%2B-blue.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Node 24 **SSH client** library (TypeScript). Open a session, run commands on an
interactive shell, read output. Tuned for DrayOS-style prompts and pagers on
Vigor 3912S, usable as a general SSH exec helper from any Node app.

## Status

**Scaffold** (`v0.0.0`). Plan: [`BACKLOG.md`](./BACKLOG.md) · [`HANDOVER.md`](./HANDOVER.md).

## Intended API (planned)

```ts
const client = new SshClient({
  host: '192.168.1.1',
  port: 22,
  username: 'admin',
  password: '…',
  hostFingerprint: 'SHA256:…', // required unless insecure skip (tests only)
});

await client.connect();
const out = await client.exec('sys version');
await client.disconnect();
```

Exact method names may adjust during Wave C; see backlog.

## Development

```bash
nvm use   # Node 24
npm install
npm run lint
npm test
npm run build
```

## Security

Pin host keys for live use. Keep credentials in `.env` (gitignored). See
[`SECURITY.md`](./SECURITY.md).
