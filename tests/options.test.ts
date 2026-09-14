import { describe, expect, it } from 'vitest';
import { SshClientError } from '../src/errors.js';
import { DEFAULTS, resolveOptions } from '../src/options.js';
import type { SshClientOptions } from '../src/public-types.js';

const validOptions: SshClientOptions = {
  host: 'router.local',
  username: 'admin',
  password: 'secret',
  hostFingerprint: 'SHA256:abc123',
};

describe('resolveOptions', () => {
  it.each([
    ['host', { ...validOptions, host: ' ' }, 'host is required'],
    ['username', { ...validOptions, username: '' }, 'username is required'],
    ['password', { ...validOptions, password: '' }, 'password is required'],
    ['hostFingerprint', { ...validOptions, hostFingerprint: undefined }, 'hostFingerprint is required unless insecureSkipVerify is true'],
  ] satisfies Array<[string, SshClientOptions, string]>)('throws invalid for missing %s', (_field, input, message) => {
    expect(() => resolveOptions(input)).toThrow(SshClientError);

    try {
      resolveOptions(input);
    } catch (error) {
      expect(error).toMatchObject({ code: 'invalid', message });
    }
  });

  it('allows missing host fingerprint when verification is explicitly skipped', () => {
    const resolved = resolveOptions({ ...validOptions, hostFingerprint: undefined, insecureSkipVerify: true });

    expect(resolved.hostFingerprint).toBeNull();
    expect(resolved.insecureSkipVerify).toBe(true);
  });

  it('applies defaults and trims identity fields', () => {
    const resolved = resolveOptions({ ...validOptions, host: ' router.local ', username: ' admin ' });

    expect(resolved).toMatchObject({
      host: 'router.local',
      port: DEFAULTS.port,
      username: 'admin',
      password: validOptions.password,
      readyTimeoutMs: DEFAULTS.readyTimeoutMs,
      commandTimeoutMs: DEFAULTS.commandTimeoutMs,
      maxPages: DEFAULTS.maxPages,
      maxOutputBytes: DEFAULTS.maxOutputBytes,
      settleMs: DEFAULTS.settleMs,
      promptRegex: DEFAULTS.promptRegex,
      term: DEFAULTS.term,
      rows: DEFAULTS.rows,
      cols: DEFAULTS.cols,
      idleBufferMaxBytes: DEFAULTS.idleBufferMaxBytes,
    });
  });

  it('keeps explicit PTY and idle buffer overrides', () => {
    const resolved = resolveOptions({
      ...validOptions,
      term: 'xterm',
      rows: 40,
      cols: 80,
      idleBufferMaxBytes: 1024,
    });

    expect(resolved).toMatchObject({
      term: 'xterm',
      rows: 40,
      cols: 80,
      idleBufferMaxBytes: 1024,
    });
  });

  it('keeps explicit overrides', () => {
    const promptRegex = /\$\s*$/m;
    const resolved = resolveOptions({
      ...validOptions,
      port: 2022,
      readyTimeoutMs: 1_000,
      commandTimeoutMs: 2_000,
      maxPages: 3,
      maxOutputBytes: 512,
      settleMs: 4,
      promptRegex,
    });

    expect(resolved).toMatchObject({
      port: 2022,
      readyTimeoutMs: 1_000,
      commandTimeoutMs: 2_000,
      maxPages: 3,
      maxOutputBytes: 512,
      settleMs: 4,
      promptRegex,
    });
  });

  it('rejects out-of-range numeric options', () => {
    expect(() => resolveOptions({ ...validOptions, port: 0 })).toThrow(/port must be/);
    expect(() => resolveOptions({ ...validOptions, commandTimeoutMs: -1 })).toThrow(/commandTimeoutMs/);
    expect(() => resolveOptions({ ...validOptions, settleMs: -1 })).toThrow(/settleMs/);
  });
});
