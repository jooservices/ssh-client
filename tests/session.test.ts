import { describe, expect, it } from 'vitest';
import { SshClientError } from '../src/errors.js';
import { fingerprintSha256 } from '../src/host-key.js';
import { resolveOptions } from '../src/options.js';
import { SshSession } from '../src/session.js';
import { FakeSsh2Client } from './support/fake-ssh2.js';

const hostKey = Buffer.from('session-host-key');

function sessionWith(fake: FakeSsh2Client, overrides: Parameters<typeof resolveOptions>[0] = {}): SshSession {
  const opts = resolveOptions({
    host: 'router.local',
    username: 'admin',
    password: 'secret',
    hostFingerprint: fingerprintSha256(hostKey),
    ...overrides,
  });

  return new SshSession(opts, () => fake);
}

describe('SshSession', () => {
  it('connects with password authentication and opens a shell after host-key verification', async () => {
    const fake = new FakeSsh2Client({ hostKey });
    const session = sessionWith(fake);

    await session.connect();

    expect(session.isOpen).toBe(true);
    expect(session.getStream()).toBe(fake.channel);
    expect(fake.connectConfig).toMatchObject({
      host: 'router.local',
      port: 22,
      username: 'admin',
      password: 'secret',
      readyTimeout: 20_000,
    });
    expect(fake.hostVerifierKeys).toEqual([hostKey]);
  });

  it('omits hostVerifier when insecureSkipVerify is true', async () => {
    const fake = new FakeSsh2Client({ hostKey });
    const session = sessionWith(fake, { hostFingerprint: undefined, insecureSkipVerify: true });

    await session.connect();

    expect(fake.connectConfig?.hostVerifier).toBeUndefined();
    expect(fake.hostVerifierKeys).toEqual([]);
  });

  it('maps host-key mismatch to connect and leaves the session closed', async () => {
    const fake = new FakeSsh2Client({ hostKey: Buffer.from('unexpected-host-key') });
    const session = sessionWith(fake);

    await expect(session.connect()).rejects.toMatchObject({ code: 'connect' });
    expect(session.isOpen).toBe(false);
    expect(fake.ended).toBe(true);
  });

  it('maps password authentication failure to auth', async () => {
    const fake = new FakeSsh2Client({ hostKey, authFailure: true });
    const session = sessionWith(fake);

    await expect(session.connect()).rejects.toMatchObject({ code: 'auth' });
    expect(session.isOpen).toBe(false);
  });

  it('maps shell open failure to connect', async () => {
    const fake = new FakeSsh2Client({ hostKey, shellError: new Error('shell refused') });
    const session = sessionWith(fake);

    await expect(session.connect()).rejects.toMatchObject({ code: 'connect', message: 'shell refused' });
    expect(session.isOpen).toBe(false);
  });

  it('throws closed when the stream is requested before connecting', () => {
    const fake = new FakeSsh2Client({ hostKey });
    const session = sessionWith(fake);

    expect(() => session.getStream()).toThrow(SshClientError);
    expect(() => session.getStream()).toThrow('not connected');
    expect(() => session.getIo()).toThrow(SshClientError);
    expect(() => session.getIo()).toThrow('not connected');
  });

  it('returns immediately when connect is called on an open session', async () => {
    const fake = new FakeSsh2Client({ hostKey });
    const session = sessionWith(fake);

    await session.connect();
    await session.connect();

    expect(session.isOpen).toBe(true);
    expect(session.getIo()).toBeTruthy();
  });

  it('shares one in-flight connect promise across concurrent callers', async () => {
    const fake = new FakeSsh2Client({ hostKey });
    const session = sessionWith(fake);

    const first = session.connect();
    const second = session.connect();
    await Promise.all([first, second]);

    expect(session.isOpen).toBe(true);
  });

  it('maps channel close during ready wait to connect (not timeout)', async () => {
    const fake = new FakeSsh2Client({ hostKey, initialPromptDelayMs: 5_000 });
    const session = sessionWith(fake, { readyTimeoutMs: 5_000, settleMs: 0 });
    const pending = session.connect();
    await new Promise((r) => setTimeout(r, 20));
    fake.channel.close();
    await expect(pending).rejects.toMatchObject({ code: 'connect' });
    expect(session.isOpen).toBe(false);
  });

  it('disconnects idempotently and clears client and stream state', async () => {
    const fake = new FakeSsh2Client({ hostKey });
    const session = sessionWith(fake);

    await session.connect();
    await session.disconnect();
    await session.disconnect();

    expect(session.isOpen).toBe(false);
    expect(fake.channel.closed).toBe(true);
    expect(fake.ended).toBe(true);
  });

  it('marks the session closed when the remote closes the shell channel', async () => {
    const fake = new FakeSsh2Client({ hostKey });
    const session = sessionWith(fake);

    await session.connect();
    fake.channel.close();

    expect(session.isOpen).toBe(false);
  });

  it('times out when the ready prompt is delayed past readyTimeoutMs', async () => {
    const fake = new FakeSsh2Client({
      hostKey,
      initialPromptDelayMs: 5_000,
    });
    const session = sessionWith(fake, { readyTimeoutMs: 80, settleMs: 0 });
    await expect(session.connect()).rejects.toMatchObject({ code: 'timeout' });
    expect(session.isOpen).toBe(false);
  });

  it('maps non-Error connect failures to connect', async () => {
    const fake = new FakeSsh2Client({ hostKey, connectError: 'socket hung up' as unknown as Error });
    const session = sessionWith(fake);
    await expect(session.connect()).rejects.toMatchObject({ code: 'connect' });
  });

  it('disconnect during ready wait leaves the session closed', async () => {
    const fake = new FakeSsh2Client({ hostKey, initialPromptDelayMs: 5_000 });
    const session = sessionWith(fake, { readyTimeoutMs: 5_000, settleMs: 0 });
    const pending = session.connect();
    await new Promise((r) => setTimeout(r, 20));
    await session.disconnect();
    await expect(pending).rejects.toMatchObject({ code: expect.stringMatching(/^(closed|connect)$/) });
    expect(session.isOpen).toBe(false);
  });

  it('disconnect before shell opens rejects connect and stays closed', async () => {
    const fake = new FakeSsh2Client({ hostKey, shellDelayMs: 80 });
    const session = sessionWith(fake, { settleMs: 0 });
    const pending = session.connect();
    await new Promise((r) => setTimeout(r, 20));
    await session.disconnect();
    await expect(pending).rejects.toMatchObject({ message: /disconnected during connect/ });
    expect(session.isOpen).toBe(false);
  });
});
