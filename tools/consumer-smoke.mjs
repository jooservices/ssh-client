import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');

const source = `import { SshClient, type ExecResult } from '@jooservices/ssh-client';

const ok: ExecResult = { stdout: '', durationMs: 0, sendAt: 0, recvAt: 0, connectMs: 0 };
void ok;
void SshClient;

// @ts-expect-error missing recvAt must fail
const bad: ExecResult = { stdout: '', durationMs: 0, sendAt: 0, connectMs: 0 };
void bad;
`;

const dir = await mkdtemp(path.join(tmpdir(), 'ssh-client-consumer-'));

try {
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'ssh-client-consumer-smoke',
      private: true,
      type: 'module',
      dependencies: {
        '@jooservices/ssh-client': `file:${root}`,
      },
    }),
  );
  await writeFile(
    path.join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2024',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      },
      include: ['index.ts'],
    }),
  );
  await writeFile(path.join(dir, 'index.ts'), source);
  await exec('npm', ['install', '--ignore-scripts'], { cwd: dir });
  await exec(process.execPath, [tsc, '--noEmit', '-p', 'tsconfig.json'], { cwd: dir });
} finally {
  await rm(dir, { recursive: true, force: true });
}
