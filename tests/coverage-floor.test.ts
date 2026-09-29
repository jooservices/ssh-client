import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('per-file coverage gate', () => {
  it('per-file floor', () => {
    const low = writeSummary({
      '/repo/src/low.ts': bucket(80),
    });
    const high = writeSummary({
      '/repo/src/high.ts': bucket(90),
      '/repo/tests/ignored.test.ts': bucket(10),
    });

    const failed = runChecker(low);
    const passed = runChecker(high);

    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain('low.ts');
    expect(passed.status).toBe(0);
  });
});

function bucket(pct: number): Record<string, { pct: number; total: number }> {
  return {
    statements: { pct, total: 10 },
    branches: { pct, total: 10 },
    functions: { pct, total: 10 },
    lines: { pct, total: 10 },
  };
}

function writeSummary(files: Record<string, ReturnType<typeof bucket>>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ssh-coverage-'));
  const file = path.join(dir, 'coverage-summary.json');
  const total = bucket(100);

  writeFileSync(file, JSON.stringify({ total, ...files }));

  return file;
}

function runChecker(summaryPath: string): { status: number | null; stderr: string } {
  const result = spawnSync(process.execPath, ['tools/check-per-file-coverage.mjs', summaryPath], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8',
  });

  return { status: result.status, stderr: result.stderr };
}
