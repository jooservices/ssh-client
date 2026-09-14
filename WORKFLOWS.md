# Workflows

| Workflow | File | Triggers | Purpose |
| --- | --- | --- | --- |
| Node CI | `.github/workflows/ci.yml` | `push` / `pull_request` on `develop` and `master` | Job `ci`: `npm ci` + lint + coverage (≥90%) + build. Job `e2e`: Docker Ubuntu sshd E2E (`npm run test:e2e`). Checkouts use `persist-credentials: false`. |

Node version is pinned to **24.21.0** (`.nvmrc` / `engines`).

Scorecard / Codecov / Sonar badges are omitted until those integrations exist
for this repository.
