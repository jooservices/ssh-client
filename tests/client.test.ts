import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SshClient, fingerprintSha256 } from '../src/index.js';
import { FakeSsh2Client, type FakeSsh2ClientOptions } from './support/fake-ssh2.js';

const fakeClients: FakeSsh2Client[] = [];
const hostKey = Buffer.from('client-host-key');
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

describe('SshClient', () => {
  beforeEach(() => {
    fakeClients.length = 0;
  });

  it('connects, executes multiple commands, and disconnects against the scripted fake', async () => {
    const firstCommand = `show system ${randomUUID()}`;
    const secondCommand = `show route ${randomUUID()}`;
    const firstBody = `System ${randomUUID()}\r\n`;
    const secondBody = `Route ${randomUUID()}\r\n`;
    const fake = enqueueFake({
      commands: {
        [firstCommand]: { body: firstBody },
        [secondCommand]: { body: secondBody },
      },
    });
    const client = createClient();

    await client.connect();
    const first = await client.exec(firstCommand);
    const second = await client.exec(secondCommand);
    await client.disconnect();

    expect(first.stdout).toBe(firstBody.trim());
    expect(second.stdout).toBe(secondBody.trim());
    expect(first.durationMs).toBeGreaterThanOrEqual(0);
    expect(client.connected).toBe(false);
    expect(fake.channel.closed).toBe(true);
    expect(fake.ended).toBe(true);
  });

  it('serializes concurrent exec calls in FIFO order without interleaving commands', async () => {
    const firstCommand = `first ${randomUUID()}`;
    const secondCommand = `second ${randomUUID()}`;
    const fake = enqueueFake({
      commands: {
        [firstCommand]: { body: `alpha ${randomUUID()}\n`, delayMs: 20 },
        [secondCommand]: { body: `beta ${randomUUID()}\n` },
      },
    });
    const client = createClient();

    await client.connect();
    const first = client.exec(firstCommand);
    const second = client.exec(secondCommand);

    await expect(first).resolves.toMatchObject({ stdout: expect.stringMatching(/^alpha /u) });
    await expect(second).resolves.toMatchObject({ stdout: expect.stringMatching(/^beta /u) });
    expect(fake.channel.commands).toEqual([firstCommand, secondCommand]);
  });

  it('rejects empty commands as invalid', async () => {
    const client = createClient();

    await expect(client.exec('   ')).rejects.toMatchObject({ code: 'invalid' });
  });

  it('maps command timeouts to timeout', async () => {
    const command = `no prompt ${randomUUID()}`;
    enqueueFake({ commands: { [command]: { body: `pending ${randomUUID()}\n`, prompt: '' } } });
    const client = createClient({ commandTimeoutMs: 10 });

    await expect(client.exec(command)).rejects.toMatchObject({ code: 'timeout' });
  });

  it('maps AbortSignal cancellation to closed', async () => {
    const command = `abort ${randomUUID()}`;
    const controller = new AbortController();
    enqueueFake({ commands: { [command]: { body: `late ${randomUUID()}\n`, delayMs: 30 } } });
    const client = createClient({ commandTimeoutMs: 100 });

    const result = client.exec(command, { signal: controller.signal });
    controller.abort();

    await expect(result).rejects.toMatchObject({ code: 'closed' });
  });

  it('refuses host-key mismatches before authentication completes', async () => {
    enqueueFake({ hostKey: Buffer.from('different-client-host-key') });
    const client = createClient();

    await expect(client.connect()).rejects.toMatchObject({ code: 'connect' });
  });

  it('maps authentication failures to auth', async () => {
    enqueueFake({ authFailure: true });
    const client = createClient();

    await expect(client.connect()).rejects.toMatchObject({ code: 'auth' });
  });

  it('allows repeated disconnects without throwing', async () => {
    enqueueFake();
    const client = createClient();

    await client.connect();
    await expect(client.disconnect()).resolves.toBeUndefined();
    await expect(client.disconnect()).resolves.toBeUndefined();
    await expect(client.disconnect()).resolves.toBeUndefined();
    expect(client.connected).toBe(false);
  });

  it('auto-reconnects when exec is called after disconnect', async () => {
    const firstCommand = `before disconnect ${randomUUID()}`;
    const secondCommand = `after disconnect ${randomUUID()}`;
    const firstFake = enqueueFake({ commands: { [firstCommand]: { body: `first ${randomUUID()}\n` } } });
    const secondFake = enqueueFake({ commands: { [secondCommand]: { body: `second ${randomUUID()}\n` } } });
    const client = createClient();

    const first = await client.exec(firstCommand);
    await client.disconnect();
    const second = await client.exec(secondCommand);

    expect(first.stdout).toMatch(/^first /u);
    expect(second.stdout).toMatch(/^second /u);
    expect(firstFake.ended).toBe(true);
    expect(secondFake.connectConfig).not.toBeNull();
    expect(client.connected).toBe(true);
  });

  it('rejects exec-after-failed-connect with a connect error', async () => {
    const command = `failed connect ${randomUUID()}`;
    enqueueFake({ connectError: new Error('network unreachable'), commands: { [command]: { body: 'unreachable\n' } } });
    const client = createClient();

    await expect(client.exec(command)).rejects.toMatchObject({ code: 'connect', message: 'network unreachable' });
    expect(client.connected).toBe(false);
  });
});

function enqueueFake(options: FakeSsh2ClientOptions = {}): FakeSsh2Client {
  const fake = new FakeSsh2Client({ hostKey, initialPrompt: prompt, ...options });
  fakeClients.push(fake);

  return fake;
}

function createClient(overrides: Partial<ConstructorParameters<typeof SshClient>[0]> = {}): SshClient {
  return new SshClient({
    commandTimeoutMs: 100,
    host: 'router.local',
    hostFingerprint: fingerprintSha256(hostKey),
    password: 'secret',
    promptRegex: /(?:>|#)\s*$/m,
    settleMs: 0,
    username: 'admin',
    ...overrides,
  });
}
