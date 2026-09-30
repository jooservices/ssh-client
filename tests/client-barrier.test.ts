import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SshClient, fingerprintSha256 } from '../src/index.js';
import { FakeSsh2Client, type FakeSsh2ClientOptions } from './support/fake-ssh2.js';

const fakeClients: FakeSsh2Client[] = [];
const hostKey = Buffer.from('barrier-host-key');
const prompt = 'router# ';

vi.mock('ssh2', () => ({
  Client: vi.fn(function Client() {
    const fake = fakeClients.shift();

    if (!fake) {
      throw new Error('missing fake ssh2 client');
    }

    return fake;
  }),
}));

describe('SshClient barrier', () => {
  beforeEach(() => {
    fakeClients.length = 0;
  });

  it('disconnect rejects queued exec', async () => {
    const slow = `slow ${randomUUID()}`;
    const queued = `queued ${randomUUID()}`;
    enqueueFake({
      commands: {
        [slow]: { body: 'later\n', delayMs: 200 },
        [queued]: { body: 'nope\n' },
      },
    });
    const client = createClient();

    await client.connect();
    const first = client.exec(slow);
    const second = client.exec(queued);
    const disconnected = client.disconnect();

    await expect(first).rejects.toMatchObject({ code: 'closed' });
    await expect(second).rejects.toMatchObject({ code: 'closed' });
    await disconnected;
    expect(fakeClients).toHaveLength(0);
    expect(client.connected).toBe(false);
  });

  it('connect during disconnect rejects', async () => {
    enqueueFake();
    const client = createClient();

    await client.connect();
    const pending = client.disconnect();

    await expect(client.connect()).rejects.toMatchObject({ code: 'closed', message: 'disconnected' });
    await pending;
    expect(client.connected).toBe(false);
  });

  it('connect loses when disconnect starts before the open session settles', async () => {
    enqueueFake();
    const client = createClient();

    await client.connect();
    const again = client.connect();
    const assertion = expect(again).rejects.toMatchObject({ code: 'closed', message: 'disconnected' });
    const pending = client.disconnect();

    await assertion;
    await pending;
    expect(client.connected).toBe(false);
  });

  it('overlapping disconnects keep the barrier until the latest one finishes', async () => {
    enqueueFake();
    enqueueFake();
    const client = createClient();

    await client.connect();
    const first = client.disconnect();
    const second = client.disconnect();

    await first;
    await second;
    expect(client.connected).toBe(false);
    await client.connect();
    expect(client.connected).toBe(true);
    await client.disconnect();
  });

  it('exec during disconnect rejects', async () => {
    enqueueFake();
    const client = createClient();

    await client.connect();
    const pending = client.disconnect();

    await expect(client.exec(`show ${randomUUID()}`)).rejects.toMatchObject({ code: 'closed' });
    await pending;
    expect(fakeClients).toHaveLength(0);
  });

  it('exec maxOutputBytes above instance', async () => {
    const fake = enqueueFake();
    const client = createClient({ maxOutputBytes: 32 });

    await expect(client.exec(`show ${randomUUID()}`, { maxOutputBytes: 64 })).rejects.toMatchObject({ code: 'invalid' });
    expect(fake.connectConfig).toBeNull();
    expect(client.connected).toBe(false);
  });

  it('oversized command', async () => {
    const command = `big ${randomUUID()}`;
    const fake = enqueueFake({ commands: { [command]: { body: '1234567890\n' } } });
    const client = createClient({ maxOutputBytes: 8 });

    await expect(client.exec(command)).rejects.toMatchObject({
      code: 'limit',
      message: 'command output exceeded maxOutputBytes=8',
    });
    expect(client.connected).toBe(false);
    expect(fake.ended).toBe(true);
  });

  it('idleTimeoutMs 0 and omitted accepted', async () => {
    const first = `idle0 ${randomUUID()}`;
    const second = `idleOmit ${randomUUID()}`;
    enqueueFake({
      commands: {
        [first]: { body: 'a\n' },
        [second]: { body: 'b\n' },
      },
    });
    const client = createClient();

    await expect(client.exec(first, { idleTimeoutMs: 0 })).resolves.toMatchObject({ stdout: 'a' });
    await expect(client.exec(second)).resolves.toMatchObject({ stdout: 'b' });
  });

  it('exec timeoutMs above instance default but within 600000 is accepted', async () => {
    const command = `slow ok ${randomUUID()}`;
    enqueueFake({ commands: { [command]: { body: 'ok\n', delayMs: 40 } } });
    const client = createClient({ commandTimeoutMs: 10 });

    await expect(client.exec(command, { timeoutMs: 500 })).resolves.toMatchObject({ stdout: 'ok' });
  });

  it('rejects a negative idleTimeoutMs before connect', async () => {
    const fake = enqueueFake();
    const client = createClient();
    const controller = new AbortController();

    controller.abort();

    await expect(client.exec(`show ${randomUUID()}`, { idleTimeoutMs: -1, signal: controller.signal })).rejects.toMatchObject({
      code: 'invalid',
    });
    expect(fake.connectConfig).toBeNull();
  });

  it('rejects an already aborted signal before connect', async () => {
    const fake = enqueueFake();
    const client = createClient();
    const controller = new AbortController();

    controller.abort();

    await expect(client.exec(`show ${randomUUID()}`, { signal: controller.signal })).rejects.toMatchObject({ code: 'closed' });
    expect(fake.connectConfig).toBeNull();
  });

  it('bash prompt captured', async () => {
    const command = `echo hi ${randomUUID()}`;
    const bash = 'user@host:~$ ';
    enqueueFake({
      initialPrompt: bash,
      commands: { [command]: { body: 'hi\n', prompt: bash } },
    });
    const client = createClient();

    await client.connect();
    await expect(client.exec(command)).resolves.toMatchObject({ stdout: 'hi' });
  });

  it('changed prompt times out', async () => {
    const command = `prompt ${randomUUID()}`;
    enqueueFake({
      commands: { [command]: { body: 'value\n', prompt: 'router> ' } },
    });
    const client = createClient({ commandTimeoutMs: 40 });

    await expect(client.exec(command)).rejects.toMatchObject({ code: 'timeout' });
    await client.disconnect();
  });

  it('resync success keeps the session', async () => {
    const stuck = `stuck ${randomUUID()}`;
    const next = `next ${randomUUID()}`;
    const fake = enqueueFake({
      commands: {
        [stuck]: { body: 'x\n', prompt: '' },
        [next]: { body: 'ok\n' },
      },
    });
    const client = createClient({ commandTimeoutMs: 30 });

    await expect(client.exec(stuck)).rejects.toMatchObject({ code: 'timeout' });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(client.connected).toBe(true);
    await expect(client.exec(next)).resolves.toMatchObject({ stdout: 'ok' });
    expect(fake.endCount).toBe(0);
  });

  it('resync failure closes the session', async () => {
    const stuck = `dead ${randomUUID()}`;
    const fake = enqueueFake({
      ignoreInterrupt: true,
      commands: { [stuck]: { body: 'x\n', prompt: '' } },
    });
    const client = createClient({ commandTimeoutMs: 30 });

    await expect(client.exec(stuck)).rejects.toMatchObject({ code: 'timeout' });
    await new Promise((resolve) => setTimeout(resolve, 5_200));

    expect(client.connected).toBe(false);
    expect(fake.ended).toBe(true);
  }, 8_000);
});

function enqueueFake(options: FakeSsh2ClientOptions = {}): FakeSsh2Client {
  const fake = new FakeSsh2Client({ hostKey, initialPrompt: prompt, ...options });
  fakeClients.push(fake);

  return fake;
}

function createClient(overrides: Partial<ConstructorParameters<typeof SshClient>[0]> = {}): SshClient {
  return new SshClient({
    commandTimeoutMs: 200,
    host: 'router.local',
    hostFingerprint: fingerprintSha256(hostKey),
    password: 'secret',
    settleMs: 0,
    username: 'admin',
    ...overrides,
  });
}
