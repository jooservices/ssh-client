import { SshClientError } from './errors.js';
import type { SshClientOptions } from './public-types.js';

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
}

export const DEFAULTS = {
  port: 22,
  readyTimeoutMs: 20_000,
  commandTimeoutMs: 15_000,
  maxPages: 60,
  maxOutputBytes: 8_388_608,
  settleMs: 150,
  promptRegex: /(?:>|#)\s*$/m,
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

  return {
    host: input.host.trim(),
    port: input.port ?? DEFAULTS.port,
    username: input.username.trim(),
    password: input.password,
    hostFingerprint,
    insecureSkipVerify,
    readyTimeoutMs: input.readyTimeoutMs ?? DEFAULTS.readyTimeoutMs,
    commandTimeoutMs: input.commandTimeoutMs ?? DEFAULTS.commandTimeoutMs,
    maxPages: input.maxPages ?? DEFAULTS.maxPages,
    maxOutputBytes: input.maxOutputBytes ?? DEFAULTS.maxOutputBytes,
    settleMs: input.settleMs ?? DEFAULTS.settleMs,
    promptRegex: input.promptRegex ?? DEFAULTS.promptRegex,
  };
}
