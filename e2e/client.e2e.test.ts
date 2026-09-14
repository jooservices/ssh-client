import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { SshClient as SshClientInstance, SshClientError, SshClientOptions } from '../src/index.js';

const env = readEnv();
const describeE2e = env ? describe : describe.skip;
let SshClient: new (options: SshClientOptions) => SshClientInstance;

describeE2e('SshClient Docker Ubuntu E2E', () => {
  const clients: SshClientInstance[] = [];

  beforeAll(async () => {
    ({ SshClient } = await import('../dist/index.js'));
  });

  afterEach(async () => {
    await Promise.all(clients.map((client) => client.disconnect()));
    clients.length = 0;
  });

  it('connects and executes echo without shell echo or prompt junk', async () => {
    const client = createClient();

    await client.connect();
    const result = await client.exec('echo hello');

    expect(result.stdout).toBe('hello');
  });

  it('executes whoami as tester', async () => {
    const client = createClient();

    const result = await client.exec('whoami');

    expect(result.stdout).toBe('tester');
  });

  it('runs two sequential execs on one session', async () => {
    const client = createClient();

    const first = await client.exec('echo first');
    const second = await client.exec('echo second');

    expect(first.stdout).toBe('first');
    expect(second.stdout).toBe('second');
  });

  it('auto-reconnects after disconnect before exec', async () => {
    const client = createClient();

    await client.connect();
    await client.disconnect();
    const result = await client.exec('echo reconnected');

    expect(result.stdout).toBe('reconnected');
  });

  it('rejects host-key mismatch before running commands', async () => {
    const client = createClient({ hostFingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });

    await expect(client.connect()).rejects.toMatchObject({
      name: 'SshClientError',
      code: 'connect',
    } satisfies Partial<SshClientError>);
    expect(client.connected).toBe(false);
  });

  function createClient(overrides: Partial<SshClientOptions> = {}): SshClientInstance {
    if (!env) {
      throw new Error('SSH E2E environment is not configured');
    }

    const client = new SshClient({
      host: env.host,
      port: env.port,
      username: env.username,
      password: env.password,
      hostFingerprint: env.hostFingerprint,
      readyTimeoutMs: 10_000,
      commandTimeoutMs: 10_000,
      promptRegex: /(?:[>#$])\s*$/m,
      ...overrides,
    });

    clients.push(client);

    return client;
  }
});

interface E2eEnv {
  host: string;
  port: number;
  username: string;
  password: string;
  hostFingerprint: string;
}

function readEnv(): E2eEnv | null {
  const host = process.env.SSH_HOST;
  const port = Number(process.env.SSH_PORT);
  const username = process.env.SSH_USER;
  const password = process.env.SSH_PASSWORD;
  const hostFingerprint = process.env.SSH_HOST_FINGERPRINT;

  if (!host || !Number.isInteger(port) || port <= 0 || !username || !password || !hostFingerprint) {
    return null;
  }

  return { host, port, username, password, hostFingerprint };
}
