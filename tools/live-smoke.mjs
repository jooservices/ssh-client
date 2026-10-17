#!/usr/bin/env node
// Opt-in live smoke against a real SSH host. Not referenced by any live test.
// It always verifies a pinned key and only reports output size and timings.

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const READ_COMMAND = 'sys version';

export async function runLiveSmoke({
  env = process.env,
  loadClient = () => import('../dist/index.js'),
  log = (message) => console.log(message),
  logError = (message) => console.error(message),
} = {}) {
  if (!env.SSH_HOST || !env.SSH_USER || !env.SSH_PASSWORD) {
    logError('live smoke requires SSH_HOST, SSH_USER, and SSH_PASSWORD (see .env.example)');
    return 1;
  }

  if (!env.SSH_HOST_FINGERPRINT) {
    logError('refusing to connect without SSH_HOST_FINGERPRINT');
    return 1;
  }

  let SshClient;
  let SshClientError;
  try {
    ({ SshClient, SshClientError } = await loadClient());
  } catch {
    logError('cannot load the built package — run `npm run build` first');
    return 1;
  }

  let client;
  let result;
  let errorCode;

  try {
    client = new SshClient({
      host: env.SSH_HOST,
      port: env.SSH_PORT ? Number(env.SSH_PORT) : undefined,
      username: env.SSH_USER,
      password: env.SSH_PASSWORD,
      hostFingerprint: env.SSH_HOST_FINGERPRINT,
    });

    await client.connect();
    result = await client.exec(READ_COMMAND);
  } catch (error) {
    errorCode =
      typeof SshClientError === 'function' && error instanceof SshClientError
        ? error.code
        : 'unexpected';
  }

  try {
    await client?.disconnect();
  } catch (error) {
    if (!errorCode) {
      errorCode =
        typeof SshClientError === 'function' && error instanceof SshClientError
          ? error.code
          : 'unexpected';
    }
  }

  if (errorCode) {
    logError(JSON.stringify({ errorCode }));
    return 1;
  }

  log(
    JSON.stringify({
      stdoutBytes: Buffer.byteLength(result.stdout, 'utf8'),
      durationMs: result.durationMs,
      connectMs: result.connectMs,
    }),
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runLiveSmoke();
}
