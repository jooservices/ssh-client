# Workflows

| Workflow | File | Triggers | Purpose |
| --- | --- | --- | --- |
| Node CI | `.github/workflows/ci.yml` | `push` / `pull_request` on `develop` and `master` | Job `ci`: `npm ci` + `npm run ci` (production audit, lint, test typecheck, coverage aggregate ≥90% and per file ≥85%, build, consumer typecheck). Job `e2e`: Docker Ubuntu sshd E2E (`npm run test:e2e`). Actions are pinned by commit SHA. Checkouts use `persist-credentials: false`. |
| Commitlint | `.github/workflows/commitlint.yml` | `pull_request` | Job `Validate commit messages`. Config: `.github/commitlint.config.mjs`. |
| Semantic PR Title | `.github/workflows/semantic-pr.yml` | `pull_request` | Job `Validate PR Title`. Subject must start with an uppercase letter. |
| CodeQL | `.github/workflows/codeql.yml` | `push` / `pull_request` on `develop` and `master`, weekly schedule | Job `Analyze` for `javascript-typescript` and `actions`. |
| OpenSSF Scorecard | `.github/workflows/scorecard.yml` | `push` on `develop`, weekly schedule, `workflow_dispatch` | Publishes the branchless Scorecard result. |
| Dependabot | `.github/dependabot.yml` | weekly | npm and GitHub Actions updates. |

Node version is pinned to **24.21.0** (`.nvmrc` / `engines`).

Codecov and Sonar badges are omitted until those integrations exist for this repository.
