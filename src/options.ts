import { SshClientError } from './errors.js';
import { normalizePromptRegex } from './prompt.js';
import type { ExecOptions, ShellPtyOptions, SshClientOptions } from './public-types.js';

export interface ResolvedOptions {
  host: string;
  port: number;
  username: string;
  password: string;
  hostFingerprint: string | null;
  insecureSkipVerify: boolean;
  readyTimeoutMs: number;
  commandTimeoutMs: number;
  maxPages: number;
  maxOutputBytes: number;
  settleMs: number;
  promptRegex: RegExp | null;
  term: string;
  rows: number;
  cols: number;
  idleBufferMaxBytes: number;
}

export interface ResolvedExecOptions {
  timeoutMs: number;
  idleTimeoutMs: number;
  maxPages: number;
  maxOutputBytes: number;
}

export const LIMITS = {
  port: { min: 1, max: 65_535 },
  readyTimeoutMs: { min: 1, max: 600_000 },
  commandTimeoutMs: { min: 1, max: 600_000 },
  maxPages: { min: 1, max: 10_000 },
  maxOutputBytes: { min: 1, max: 67_108_864 },
  settleMs: { min: 0, max: 60_000 },
  rows: { min: 1, max: 10_000 },
  cols: { min: 1, max: 10_000 },
  idleBufferMaxBytes: { min: 1_024, max: 67_108_864 },
  timeoutMs: { min: 1, max: 600_000 },
  idleTimeoutMs: { min: 1, max: 600_000 },
} as const;

export const DEFAULTS = {
  port: 22,
  readyTimeoutMs: 20_000,
  commandTimeoutMs: 15_000,
  maxPages: 60,
  maxOutputBytes: 8_388_608,
  settleMs: 150,
  term: 'vt100',
  rows: 200,
  cols: 200,
  idleBufferMaxBytes: 64 * 1024,
} as const;

export const RESYNC_TIMEOUT_MS = 5_000;

export function requireFiniteInt(name: string, value: number, min: number, max: number): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max) {
    throw new SshClientError('invalid', `${name} must be an integer between ${min} and ${max}`);
  }
}

export function resolveOptions(input: SshClientOptions): ResolvedOptions {
  if (!input.host?.trim()) {
    throw new SshClientError('invalid', 'host is required');
  }

  if (!input.username?.trim()) {
    throw new SshClientError('invalid', 'username is required');
  }

  if (!input.password) {
    throw new SshClientError('invalid', 'password is required');
  }

  const insecureSkipVerify = input.insecureSkipVerify === true;
  const hostFingerprint = input.hostFingerprint?.trim() || null;

  if (!insecureSkipVerify && !hostFingerprint) {
    throw new SshClientError('invalid', 'hostFingerprint is required unless insecureSkipVerify is true');
  }

  const port = input.port ?? DEFAULTS.port;
  const readyTimeoutMs = input.readyTimeoutMs ?? DEFAULTS.readyTimeoutMs;
  const commandTimeoutMs = input.commandTimeoutMs ?? DEFAULTS.commandTimeoutMs;
  const maxPages = input.maxPages ?? DEFAULTS.maxPages;
  const maxOutputBytes = input.maxOutputBytes ?? DEFAULTS.maxOutputBytes;
  const settleMs = input.settleMs ?? DEFAULTS.settleMs;
  const rows = input.rows ?? DEFAULTS.rows;
  const cols = input.cols ?? DEFAULTS.cols;
  const idleBufferMaxBytes = input.idleBufferMaxBytes ?? DEFAULTS.idleBufferMaxBytes;

  requireFiniteInt('port', port, LIMITS.port.min, LIMITS.port.max);
  requireFiniteInt('readyTimeoutMs', readyTimeoutMs, LIMITS.readyTimeoutMs.min, LIMITS.readyTimeoutMs.max);
  requireFiniteInt('commandTimeoutMs', commandTimeoutMs, LIMITS.commandTimeoutMs.min, LIMITS.commandTimeoutMs.max);
  requireFiniteInt('maxPages', maxPages, LIMITS.maxPages.min, LIMITS.maxPages.max);
  requireFiniteInt('maxOutputBytes', maxOutputBytes, LIMITS.maxOutputBytes.min, LIMITS.maxOutputBytes.max);
  requireFiniteInt('settleMs', settleMs, LIMITS.settleMs.min, LIMITS.settleMs.max);
  requireFiniteInt('rows', rows, LIMITS.rows.min, LIMITS.rows.max);
  requireFiniteInt('cols', cols, LIMITS.cols.min, LIMITS.cols.max);
  requireFiniteInt(
    'idleBufferMaxBytes',
    idleBufferMaxBytes,
    LIMITS.idleBufferMaxBytes.min,
    LIMITS.idleBufferMaxBytes.max,
  );

  return {
    host: input.host.trim(),
    port,
    username: input.username.trim(),
    password: input.password,
    hostFingerprint,
    insecureSkipVerify,
    readyTimeoutMs,
    commandTimeoutMs,
    maxPages,
    maxOutputBytes,
    settleMs,
    promptRegex: input.promptRegex ? normalizePromptRegex(input.promptRegex) : null,
    term: input.term ?? DEFAULTS.term,
    rows,
    cols,
    idleBufferMaxBytes,
  };
}

export function resolveExecOptions(base: ResolvedOptions, input?: ExecOptions): ResolvedExecOptions {
  const timeoutMs = input?.timeoutMs ?? base.commandTimeoutMs;
  const maxPages = input?.maxPages ?? base.maxPages;
  const maxOutputBytes = input?.maxOutputBytes ?? base.maxOutputBytes;
  const idleTimeoutMs = input?.idleTimeoutMs ?? 0;

  requireFiniteInt('timeoutMs', timeoutMs, LIMITS.timeoutMs.min, LIMITS.timeoutMs.max);
  requireFiniteInt('maxPages', maxPages, 1, base.maxPages);
  requireFiniteInt('maxOutputBytes', maxOutputBytes, 1, base.maxOutputBytes);

  if (idleTimeoutMs !== 0) {
    requireFiniteInt('idleTimeoutMs', idleTimeoutMs, LIMITS.idleTimeoutMs.min, LIMITS.idleTimeoutMs.max);
  }

  return { timeoutMs, idleTimeoutMs, maxPages, maxOutputBytes };
}

export function ptyOptions(opts: ResolvedOptions): ShellPtyOptions {
  return { term: opts.term, rows: opts.rows, cols: opts.cols };
}
