import { describe, expect, it } from 'vitest';
import { SshClient, SshClientError, fingerprintSha256 } from '../src/index.js';
import type { ExecOptions, ExecResult, SshClientOptions, SshErrorCode } from '../src/index.js';

describe('public barrel', () => {
  it('exposes the stable constructors and helper functions', () => {
    expect(SshClient).toBeTypeOf('function');
    expect(new SshClientError('invalid', 'bad input')).toBeInstanceOf(Error);
    expect(fingerprintSha256(Buffer.from('barrel-host-key'))).toMatch(/^SHA256:/u);
  });

  it('exports the public TypeScript surface', () => {
    const options: SshClientOptions = {
      host: 'router.local',
      hostFingerprint: 'SHA256:test',
      password: 'secret',
      username: 'admin',
    };
    const execOptions: ExecOptions = { maxPages: 2, timeoutMs: 50 };
    const result: ExecResult = { durationMs: 1, stdout: 'ok' };
    const code: SshErrorCode = 'invalid';

    expect(options.host).toBe('router.local');
    expect(execOptions.maxPages).toBe(2);
    expect(result.stdout).toBe('ok');
    expect(code).toBe('invalid');
  });
});
