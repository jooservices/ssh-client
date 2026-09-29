# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- A socket error that arrives after the SSH client is closed no longer becomes an uncaught exception.

## [1.1.0] - 2026-09-29

### Added

- Optional full-line `promptRegex`. When it is omitted, the first ready prompt line is captured and later commands must repeat that exact line.
- Per-file coverage floor of 85% and a consumer typecheck smoke inside `npm run ci`.

### Fixed

- A client `error` after the session is ready no longer crashes the process. The listener stays until teardown.
- A stale shell callback or client `close` from an older attempt cannot clear a newer session.
- `disconnect()` rejects in-flight and already queued `exec` calls with `closed`. A new `exec` may reconnect only after `disconnect()` resolves.
- `stdout` keeps indentation, blank lines, and leading `#` / `>`. Only the first command echo is removed.
- UTF-8 characters split across socket chunks stay intact.
- `readyTimeoutMs` is one budget from `connect()` through handshake, shell open, and the first prompt. An ssh2 handshake timeout is reported as `timeout`.
- A failed prompt resync closes the session.
- Invalid `ExecOptions` fail with `invalid` before any connect or write. Ready banners and command output share the `maxOutputBytes` cap.

### Changed

- Command completion no longer treats a line that merely ends with `#` or `>` as the prompt.
- `exec` still writes one raw line to the interactive shell. It does not return an exit code or a separate stderr stream.

## [1.0.0] - 2026-09-14

### Added

- Per-command `idleTimeoutMs` on `ExecOptions` (no-output idle abort).
- Runtime range validation for public numeric SSH options.
- Unit coverage for write-failure waiter cleanup, settle late-chunk inclusion,
  disconnect-during-connect, and idle timeout.

### Fixed

- Command `stream.write` exceptions no longer leave a stuck in-flight waiter.
- Prompt settle timer re-reads the buffer so late chunks during `settleMs` are kept.
- Timeout resync clears buffered output and can be abandoned cleanly before the
  next command.
- Disconnect during an in-flight connect no longer leaves `isOpen: true`.

### Changed

- First stable **1.0.0** line for the interactive-shell SSH client API.
- CI checkouts use `persist-credentials: false`.
- Documented Node engine pin `>=24.21.0 <25` and full `ExecResult` timing fields.

## [0.5.0] - 2026-09-14

### Added

- Project scaffold and implementation plan for a standalone SSH client library.
- SSH client implementation (tasks C1–C7):
  - `SshClient` public API: `connect()`, `exec(command, options?)`,
    `disconnect()`, and the `connected` getter; `exec` returns
    `{ stdout, durationMs }`.
  - Options validation and stable error codes via `SshClientError`
    (`connect | auth | timeout | closed | invalid`) (C1).
  - `ssh2` password-auth sessions with SHA-256 host-key pinning by default;
    `insecureSkipVerify` for tests only; exported `fingerprintSha256` helper (C2).
  - Interactive shell I/O: prompt detection (`promptRegex`), command-echo
    stripping, `--- MORE ---` pager handling capped by `maxPages` (C3).
  - Session hygiene: serialized `exec`, auto-reconnect on demand, safe
    double `disconnect`, `maxOutputBytes` output cap (default 8 MiB) (C5).
  - Operator docs: README usage, `docs/usage.md`, `SSH_*` `.env.example`, and
    an opt-in live smoke script `tools/live-smoke.mjs` (C6).
  - Docker Ubuntu E2E suite (`docker/Dockerfile`, `tools/e2e.sh`,
    `npm run test:e2e`), opt-in and separate from unit tests (C7).
