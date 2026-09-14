# Contributing

## Setup

```bash
nvm use
npm install
git config core.hooksPath .githooks
npm run ci
```

## Commits

Conventional Commits, English only. Author/committer:
`Viet Vu <jooservices@gmail.com>`.

Hooks: `.githooks/commit-msg` (Conventional Commits), `pre-commit`
(whitespace, `.env` block, lint), `pre-push` (unit tests). Never use
`--no-verify`.

## Branches

`feature/*` / `fix/*` / … from `develop`, PR into `develop`. Release via
`release/<version>` → `master`.
