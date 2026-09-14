#!/usr/bin/env node
// Opt-in live smoke against a real SSH host. Not referenced by any test suite.
//
// Usage:
//   npm run build
//   set -a; . ./.env; set +a
//   node tools/live-smoke.mjs
//
// Reads SSH_HOST, SSH_PORT, SSH_USER, SSH_PASSWORD, SSH_HOST_FINGERPRINT,
// SSH_INSECURE_SKIP_VERIFY from the environment (see .env.example). Refuses to
// connect without a pinned SSH_HOST_FINGERPRINT unless SSH_INSECURE_SKIP_VERIFY
// is "true" (test hosts only). Prints { stdout, durationMs } on success; on
// failure prints the SshClientError code and exits non-zero.

const { SSH_HOST, SSH_PORT, SSH_USER, SSH_PASSWORD, SSH_HOST_FINGERPRINT, SSH_INSECURE_SKIP_VERIFY } =
  process.env;

const insecureSkipVerify = SSH_INSECURE_SKIP_VERIFY === 'true';

if (!SSH_HOST || !SSH_USER || !SSH_PASSWORD) {
  console.error('live smoke requires SSH_HOST, SSH_USER, and SSH_PASSWORD (see .env.example)');
  process.exit(1);
}

if (!SSH_HOST_FINGERPRINT && !insecureSkipVerify) {
  console.error(
    'refusing to connect without SSH_HOST_FINGERPRINT; ' +
      'pin the host key or set SSH_INSECURE_SKIP_VERIFY=true for test hosts only',
  );
  process.exit(1);
}

let SshClient;
let SshClientError;

try {
  ({ SshClient, SshClientError } = await import('../dist/index.js'));
} catch {
  console.error('cannot load the built package — run `npm run build` first');
  process.exit(1);
}

let client = null;

try {
  client = new SshClient({
    host: SSH_HOST,
    port: SSH_PORT ? Number(SSH_PORT) : undefined,
    username: SSH_USER,
    password: SSH_PASSWORD,
    hostFingerprint: SSH_HOST_FINGERPRINT,
    insecureSkipVerify,
  });

  await client.connect();
  const result = await client.exec('echo ssh-client-live-smoke-ok');
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  if (err instanceof SshClientError) {
    console.error(`live smoke failed: code=${err.code} message=${err.message}`);
  } else {
    console.error('live smoke failed with unexpected error:', err);
  }

  process.exitCode = 1;
} finally {
  await client?.disconnect();
}
