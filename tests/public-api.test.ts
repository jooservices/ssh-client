import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ExecResult } from '../src/index.js';

describe('public API types', () => {
  it('ExecResult requires timing fields', () => {
    expectTypeOf<ExecResult>().toHaveProperty('stdout');
    expectTypeOf<ExecResult>().toHaveProperty('durationMs');
    expectTypeOf<ExecResult>().toHaveProperty('sendAt');
    expectTypeOf<ExecResult>().toHaveProperty('recvAt');
    expectTypeOf<ExecResult>().toHaveProperty('connectMs');

    const value: ExecResult = { stdout: 'ok', durationMs: 1, sendAt: 0, recvAt: 1, connectMs: 0 };

    expect(value.recvAt).toBe(1);
  });

  it('missing recvAt is a type error', () => {
    // @ts-expect-error recvAt is required on a successful ExecResult
    const missing: ExecResult = { stdout: 'ok', durationMs: 1, sendAt: 0, connectMs: 0 };

    expect(missing.stdout).toBe('ok');
  });

  it('consumer typecheck', () => {
    const source = readFileSync(new URL('../tools/consumer-smoke.mjs', import.meta.url), 'utf8');

    expect(source).toContain('@ts-expect-error');
    expect(source).toContain('recvAt');
    expect(source).toContain('file:');
  });
});
