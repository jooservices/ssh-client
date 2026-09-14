# jooservices/vigor3912s-client

[![CI](https://github.com/jooservices/vigor3912s-client/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/jooservices/vigor3912s-client/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/Node-24%2B-blue.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Node 24 **DrayOS SSH client** for the DrayTek Vigor 3912S. Implements the
`Transport` contract owned by [`@jooservices/vigor3912s-sdk`](https://github.com/jooservices/vigor3912s)
(workspace: `projects/vigor3912s/sdk`).

## Status

**Scaffold + plan** (`v0.0.0`). No live SSH implementation yet. See
[`HANDOVER.md`](./HANDOVER.md) and [`BACKLOG.md`](./BACKLOG.md).

## Role in the three-package line

| Package | Role |
| --- | --- |
| `vigor3912s-sdk` | Typed CLI ops + **public `Transport` interface** |
| **`vigor3912s-client`** *(this)* | **SSH wire** — implements `Transport` |
| `vigor3912s-mcp` | MCP tools / confirm / audit (consumes SDK + client later) |

This package does **not** own domain parsers, MCP tools, or confirm gates.

## Prerequisite

SDK **REQ-SDK-1** must export `./transport` before this package can depend on
the real types. Until then, local stubs may mirror the contract for planning
only — do not diverge permanently.

## Development

```bash
nvm use   # Node 24
npm install
npm run lint
npm test
npm run build
```

## Security

Credentials and host-key pins belong in the consumer’s `.env` (never committed).
See [`SECURITY.md`](./SECURITY.md).
