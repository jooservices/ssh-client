import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { SshClient as SshClientInstance, SshClientError, SshClientOptions } from '../src/index.js';

const env = readEnv();
const describeE2e = env ? describe : describe.skip;
let SshClient: new (options: SshClientOptions) => SshClientInstance;

describeE2e('SshClient Docker Ubuntu E2E', () => {
  const clients: SshClientInstance[] = [];

  beforeAll(async () => {
    // Non-literal specifier: tsc runs before `dist/` exists. E2E builds first.
    const distModule = '../dist/index.js';
    const imported = (await import(distModule)) as unknown as {
      SshClient: new (options: SshClientOptions) => SshClientInstance;
    };

    SshClient = imported.SshClient;
  });

  afterEach(async () => {
    await Promise.all(clients.map((client) => client.disconnect()));
    clients.length = 0;
  });

  it('e2e default prompt echo', async () => {
    const client = createClient();

    await client.connect();
    const result = await client.exec('echo hello');

    expect(result.stdout).toBe('hello');
    expect(result.sendAt).toBeLessThanOrEqual(result.recvAt);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(client.shellWindow).toMatchObject({ term: 'vt100', rows: 200, cols: 200 });
  });

  it('executes whoami as tester', async () => {
    const client = createClient();

    const result = await client.exec('whoami');

    expect(result.stdout).toBe('tester');
  });

  it('e2e whitespace', async () => {
    const client = createClient();
    const result = await client.exec("printf '  indented\\n\\n# tag\\n'");

    expect(result.stdout).toBe('  indented\n\n# tag');
  });

  it('e2e unicode', async () => {
    const client = createClient();
    const result = await client.exec("printf 'àé\\n'");

    expect(result.stdout).toBe('àé');
  });

  it('e2e full-line prompt regex', async () => {
    const client = createClient({ promptRegex: /^\S+@\S+:\S*\$ $/u });
    const result = await client.exec('echo regex');

    expect(result.stdout).toBe('regex');
  });

  it('runs two sequential execs on one session', async () => {
    const client = createClient();

    const first = await client.exec('echo first');
    const second = await client.exec('echo second');

    expect(first.stdout).toBe('first');
    expect(second.stdout).toBe('second');
  });

  it('e2e reconnect after disconnect', async () => {
    const client = createClient();

    await client.connect();
    await client.disconnect();
    const result = await client.exec('echo reconnected');

    expect(result.stdout).toBe('reconnected');
    expect(result.connectMs).toBeGreaterThan(0);
  });

  it('e2e bad host key', async () => {
    const client = createClient({ hostFingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });

    await expect(client.connect()).rejects.toMatchObject({
      name: 'SshClientError',
      code: 'connect',
    } satisfies Partial<SshClientError>);
    expect(client.connected).toBe(false);
  });

  it('rejects an empty command before connect', async () => {
    const client = createClient();

    await expect(client.exec('   ')).rejects.toMatchObject({
      name: 'SshClientError',
      code: 'invalid',
      message: 'command is empty',
    } satisfies Partial<SshClientError>);
    expect(client.connected).toBe(false);
  });

  it('rejects invalid exec options before connect', async () => {
    const client = createClient();

    await expect(client.exec('echo no', { timeoutMs: 0 })).rejects.toMatchObject({
      name: 'SshClientError',
      code: 'invalid',
    } satisfies Partial<SshClientError>);
    expect(client.connected).toBe(false);
  });

  it('rejects an already aborted exec without connecting', async () => {
    const client = createClient();
    const controller = new AbortController();
    controller.abort();

    await expect(client.exec('echo no', { signal: controller.signal })).rejects.toMatchObject({
      name: 'SshClientError',
      code: 'closed',
      message: 'aborted',
    } satisfies Partial<SshClientError>);
    expect(client.connected).toBe(false);
  });

  it('e2e wrong password', async () => {
    const client = createClient({ password: 'not-the-password' });

    await expect(client.connect()).rejects.toMatchObject({
      name: 'SshClientError',
      code: 'auth',
    } satisfies Partial<SshClientError>);
    expect(client.connected).toBe(false);
  });

  it('e2e insecure skip verify', async () => {
    const client = createClient({ insecureSkipVerify: true });
    const result = await client.exec('echo skip');

    expect(result.stdout).toBe('skip');
    expect(client.connected).toBe(true);
  });

  it('e2e ready timeout', async () => {
    const client = createClient({ readyTimeoutMs: 1 });

    await expect(client.connect()).rejects.toMatchObject({
      name: 'SshClientError',
      code: 'timeout',
    } satisfies Partial<SshClientError>);
    expect(client.connected).toBe(false);
  });

  it('e2e prompt regex miss', async () => {
    const client = createClient({ promptRegex: /^router# $/u, readyTimeoutMs: 1_500 });

    await expect(client.connect()).rejects.toMatchObject({
      name: 'SshClientError',
      code: 'timeout',
      message: 'ready prompt timed out after 1500ms',
    } satisfies Partial<SshClientError>);
    expect(client.connected).toBe(false);
  });

  it('e2e pty term', async () => {
    const client = createClient({ term: 'xterm', rows: 24, cols: 80 });
    const result = await client.exec("printf '%s\\n' \"$TERM\"");

    expect(result.stdout).toBe('xterm');
    expect(client.shellWindow).toMatchObject({ term: 'xterm', rows: 24, cols: 80 });
  });

  it('e2e carriage return', async () => {
    const client = createClient();
    const result = await client.exec("printf 'a\\rb\\n'");

    expect(result.stdout).toBe('a\nb');
  });

  it('queues concurrent execs on one shell', async () => {
    const client = createClient();
    const first = client.exec('echo first');
    const second = client.exec('echo second');

    await expect(first).resolves.toMatchObject({ stdout: 'first' });
    await expect(second).resolves.toMatchObject({ stdout: 'second', connectMs: 0 });
  });

  it('e2e disconnect rejects queued exec', async () => {
    const client = createClient();
    const queued = client.exec('echo queued');
    const closing = client.disconnect();
    const during = client.exec('echo during');

    await expect(queued).rejects.toMatchObject({ name: 'SshClientError', code: 'closed' } satisfies Partial<SshClientError>);
    await expect(during).rejects.toMatchObject({ name: 'SshClientError', code: 'closed' } satisfies Partial<SshClientError>);
    await closing;
    expect(client.connected).toBe(false);

    const after = await client.exec('echo after');
    expect(after.stdout).toBe('after');
  });

  it('e2e disconnect rejects the in-flight exec', async () => {
    const client = createClient({ commandTimeoutMs: 20_000 });

    await client.connect();
    const running = client.exec('sleep 30');
    await delay(400);
    const closing = client.disconnect();

    await expect(running).rejects.toMatchObject({ name: 'SshClientError', code: 'closed' } satisfies Partial<SshClientError>);
    await closing;
    expect(client.connected).toBe(false);

    const after = await client.exec('echo after-inflight');
    expect(after.stdout).toBe('after-inflight');
  });

  it('e2e disconnect is idempotent', async () => {
    const client = createClient();

    await client.connect();
    await client.disconnect();
    await client.disconnect();

    expect(client.connected).toBe(false);
  });

  it('e2e command timeout keeps the session', async () => {
    const client = createClient();

    await expect(client.exec('read -n 1 -s _', { timeoutMs: 600 })).rejects.toMatchObject({
      name: 'SshClientError',
      code: 'timeout',
      message: 'command timed out after 600ms',
    } satisfies Partial<SshClientError>);
    await delay(500);

    const next = await client.exec('echo after-timeout');
    expect(next.stdout).toBe('after-timeout');
    expect(next.connectMs).toBe(0);
  });

  it('e2e idle timeout', async () => {
    const client = createClient();

    await expect(client.exec('read -n 1 -s _', { idleTimeoutMs: 400, timeoutMs: 8_000 })).rejects.toMatchObject({
      name: 'SshClientError',
      code: 'timeout',
      message: 'idle timeout after 400ms with no output',
    } satisfies Partial<SshClientError>);
    await delay(500);

    const next = await client.exec('echo after-idle');
    expect(next.stdout).toBe('after-idle');
    expect(next.connectMs).toBe(0);
  });

  it('e2e abort during exec', async () => {
    const client = createClient();
    const controller = new AbortController();

    await client.connect();
    const pending = client.exec('read -n 1 -s _', { signal: controller.signal, timeoutMs: 10_000 });
    await delay(400);
    controller.abort();

    await expect(pending).rejects.toMatchObject({
      name: 'SshClientError',
      code: 'closed',
      message: 'aborted',
    } satisfies Partial<SshClientError>);
    await delay(500);

    const next = await client.exec('echo after-abort');
    expect(next.stdout).toBe('after-abort');
    expect(next.connectMs).toBe(0);
  });

  it('e2e output cap', async () => {
    const client = createClient({ maxOutputBytes: 100_000 });
    const payload = 'x'.repeat(100);

    await expect(client.exec(`printf '%s' '${payload}'`, { maxOutputBytes: 80 })).rejects.toMatchObject({
      name: 'SshClientError',
      code: 'invalid',
      message: 'command output exceeded maxOutputBytes=80',
    } satisfies Partial<SshClientError>);
    expect(client.connected).toBe(false);

    const next = await client.exec('echo after-cap');
    expect(next.stdout).toBe('after-cap');
    expect(next.connectMs).toBeGreaterThan(0);
  });

  it('e2e pager strips more and continues', async () => {
    const client = createClient();
    const result = await client.exec("printf 'pre\\n--- %s ---\\n' MORE; read -n 1 -s _; printf 'post\\n'");

    expect(result.stdout).toBe('pre\n\npost');
  });

  it('e2e pager cap', async () => {
    const client = createClient();

    await expect(
      client.exec(
        "printf '--- MORE ---\\n'; read -n 1 -s _; printf '--- MORE ---\\n'; read -n 1 -s _; printf 'done\\n'",
        { maxPages: 1, timeoutMs: 8_000 },
      ),
    ).rejects.toMatchObject({
      name: 'SshClientError',
      code: 'timeout',
      message: 'pager exceeded maxPages=1',
    } satisfies Partial<SshClientError>);

    const next = await client.exec('echo after-pager');
    expect(next.stdout).toBe('after-pager');
  });

  it('e2e shell exit reconnects', async () => {
    const client = createClient();

    await expect(client.exec('exit')).rejects.toMatchObject({
      name: 'SshClientError',
      code: 'closed',
    } satisfies Partial<SshClientError>);
    expect(client.connected).toBe(false);

    const again = await client.exec('echo back');
    expect(again.stdout).toBe('back');
    expect(again.connectMs).toBeGreaterThan(0);
  });

  function createClient(overrides: Partial<SshClientOptions> = {}): SshClientInstance {
    if (!env) {
      throw new Error('SSH E2E environment is not configured');
    }

    const options: SshClientOptions = {
      host: env.host,
      port: env.port,
      username: env.username,
      password: env.password,
      readyTimeoutMs: 10_000,
      commandTimeoutMs: 10_000,
      ...overrides,
    };

    if (options.insecureSkipVerify !== true && options.hostFingerprint === undefined) {
      options.hostFingerprint = env.hostFingerprint;
    }

    const client = new SshClient(options);

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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
