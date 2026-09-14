# jooservices/vigor3912s-client

This file adds project-only rules.

- Node.js `>= 24`, TypeScript ESM (`NodeNext`)
- **SSH client library only** — connect, interactive shell I/O, exec, disconnect
- Public API must stay usable by any Node consumer (no coupling to other apps)
- No live router in unit tests; live smoke only with explicit approval
- Never commit `.env` or credentials
- Branch model: `master` + `develop` (no `main`)
