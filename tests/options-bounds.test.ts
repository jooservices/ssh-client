import { describe, expect, it } from 'vitest';
import { SshClientError } from '../src/errors.js';
import { resolveExecOptions, resolveOptions } from '../src/options.js';
import type { SshClientOptions } from '../src/public-types.js';

const validOptions: SshClientOptions = {
  host: 'router.local',
  username: 'admin',
  password: 'secret',
  hostFingerprint: `SHA256:${'A'.repeat(43)}`,
};

describe('option bounds', () => {
  it('boundary table', () => {
    const fields: Array<[keyof SshClientOptions, number, number]> = [
      ['port', 1, 65_535],
      ['readyTimeoutMs', 1, 600_000],
      ['commandTimeoutMs', 1, 600_000],
      ['maxPages', 1, 10_000],
      ['maxOutputBytes', 1, 67_108_864],
      ['settleMs', 0, 60_000],
      ['rows', 1, 10_000],
      ['cols', 1, 10_000],
      ['idleBufferMaxBytes', 1_024, 67_108_864],
      ['maxPromptLength', 16, 4_096],
    ];

    for (const [field, min, max] of fields) {
      expect(accepts(field, min - 1)).toBe(false);
      expect(accepts(field, min)).toBe(true);
      expect(accepts(field, max)).toBe(true);
      expect(accepts(field, max + 1)).toBe(false);

      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5]) {
        expect(accepts(field, bad)).toBe(false);
      }
    }

    const base = resolveOptions(validOptions);

    expect(execAccepts({ timeoutMs: 0 })).toBe(false);
    expect(execAccepts({ timeoutMs: 1 })).toBe(true);
    expect(execAccepts({ timeoutMs: base.commandTimeoutMs + 1 })).toBe(true);
    expect(execAccepts({ timeoutMs: 600_000 })).toBe(true);
    expect(execAccepts({ timeoutMs: 600_001 })).toBe(false);
    expect(execAccepts({ maxPages: 0 })).toBe(false);
    expect(execAccepts({ maxPages: 1 })).toBe(true);
    expect(execAccepts({ maxPages: base.maxPages })).toBe(true);
    expect(execAccepts({ maxPages: base.maxPages + 1 })).toBe(false);
    expect(execAccepts({ maxOutputBytes: 0 })).toBe(false);
    expect(execAccepts({ maxOutputBytes: 1 })).toBe(true);
    expect(execAccepts({ maxOutputBytes: base.maxOutputBytes })).toBe(true);
    expect(execAccepts({ maxOutputBytes: base.maxOutputBytes + 1 })).toBe(false);
    expect(execAccepts({ idleTimeoutMs: -1 })).toBe(false);
    expect(execAccepts({ idleTimeoutMs: 0 })).toBe(true);
    expect(execAccepts({ idleTimeoutMs: 1 })).toBe(true);
    expect(execAccepts({ idleTimeoutMs: 600_000 })).toBe(true);
    expect(execAccepts({ idleTimeoutMs: 600_001 })).toBe(false);
    expect(resolveExecOptions(base).idleTimeoutMs).toBe(0);

    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5]) {
      expect(execAccepts({ timeoutMs: bad })).toBe(false);
      expect(execAccepts({ maxPages: bad })).toBe(false);
      expect(execAccepts({ maxOutputBytes: bad })).toBe(false);
      expect(execAccepts({ idleTimeoutMs: bad })).toBe(false);
    }
  });
});

function accepts(field: keyof SshClientOptions, value: number): boolean {
  try {
    resolveOptions({ ...validOptions, [field]: value });
    return true;
  } catch (error) {
    expect(error).toBeInstanceOf(SshClientError);
    return false;
  }
}

function execAccepts(overrides: Parameters<typeof resolveExecOptions>[1]): boolean {
  try {
    resolveExecOptions(resolveOptions(validOptions), overrides);
    return true;
  } catch (error) {
    expect(error).toBeInstanceOf(SshClientError);
    return false;
  }
}
