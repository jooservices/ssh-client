import { SshClientError } from './errors.js';
import type { ShellPtyOptions, SshClientOptions } from './public-types.js';

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
  promptRegex: RegExp;
  term: string;
  rows: number;
  cols: number;
  idleBufferMaxBytes: number;
}

export const DEFAULTS = {
  port: 22,
  readyTimeoutMs: 20_000,
  commandTimeoutMs: 15_000,
  maxPages: 60,
  maxOutputBytes: 8_388_608,
  settleMs: 150,
  promptRegex: /(?:>|#)\s*$/m,
  term: 'vt100',
  rows: 200,
  cols: 200,
  idleBufferMaxBytes: 64 * 1024,
} as const;

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

  requirePositiveInt('port', port, 1, 65535);
  requirePositiveInt('readyTimeoutMs', readyTimeoutMs, 1, 600_000);
  requirePositiveInt('commandTimeoutMs', commandTimeoutMs, 1, 600_000);
  requirePositiveInt('maxPages', maxPages, 1, 10_000);
  requirePositiveInt('maxOutputBytes', maxOutputBytes, 1, 64 * 1024 * 1024);
  requirePositiveInt('settleMs', settleMs, 0, 60_000);
  requirePositiveInt('rows', rows, 1, 10_000);
  requirePositiveInt('cols', cols, 1, 10_000);
  requirePositiveInt('idleBufferMaxBytes', idleBufferMaxBytes, 1024, 64 * 1024 * 1024);

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
    promptRegex: input.promptRegex ?? DEFAULTS.promptRegex,
    term: input.term ?? DEFAULTS.term,
    rows,
    cols,
    idleBufferMaxBytes,
  };
}

function requirePositiveInt(name: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new SshClientError('invalid', `${name} must be an integer between ${min} and ${max}`);
  }
}

export function ptyOptions(opts: ResolvedOptions): ShellPtyOptions {
  return { term: opts.term, rows: opts.rows, cols: opts.cols };
}
