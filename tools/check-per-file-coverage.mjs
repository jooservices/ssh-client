import { readFileSync } from 'node:fs';

const KEYS = ['statements', 'branches', 'functions', 'lines'];

/**
 * @param {Record<string, { statements?: { pct?: number, total?: number }, branches?: { pct?: number, total?: number }, functions?: { pct?: number, total?: number }, lines?: { pct?: number, total?: number } }>} summary
 * @param {number} floor
 * @returns {string[]}
 */
export function evaluatePerFileCoverage(summary, floor = 85) {
  const failures = [];

  for (const [file, metrics] of Object.entries(summary)) {
    if (file === 'total') {
      continue;
    }

    const normalized = file.replaceAll('\\', '/');

    if (!normalized.includes('/src/') && !normalized.startsWith('src/')) {
      continue;
    }

    if (!normalized.endsWith('.ts')) {
      continue;
    }

    for (const key of KEYS) {
      const bucket = metrics?.[key];

      if (!bucket || bucket.total === 0) {
        continue;
      }

      if (typeof bucket.pct !== 'number' || bucket.pct < floor) {
        failures.push(`${normalized} ${key} ${bucket?.pct ?? 'missing'} < ${floor}`);
      }
    }
  }

  return failures;
}

const invokedDirectly = process.argv[1]?.endsWith('check-per-file-coverage.mjs') === true;

if (invokedDirectly) {
  const file = process.argv[2] ?? 'coverage/coverage-summary.json';
  const summary = JSON.parse(readFileSync(file, 'utf8'));
  const failures = evaluatePerFileCoverage(summary);

  if (failures.length > 0) {
    console.error(failures.join('\n'));
    process.exit(1);
  }
}
