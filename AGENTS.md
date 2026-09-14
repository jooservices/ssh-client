# jooservices/vigor3912s-client

This file adds project-only rules.

- Node.js `>= 24`, TypeScript ESM (`NodeNext`)
- Purpose: **DrayOS SSH wire** implementing `@jooservices/vigor3912s-sdk` `Transport`
- Does **not** own typed CLI domains, MCP tools, or confirm gates
- No live router writes in unit tests — use fakes; live E2E only with explicit approval
- Never commit `.env` or router credentials
- Branch model: `master` + `develop` (no `main`)
