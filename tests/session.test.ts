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

  it('marks the session closed when the ssh client emits close', async () => {
    const fake = new FakeSsh2Client({ hostKey });
    const session = sessionWith(fake);

    await session.connect();
    fake.emitClose();

    expect(session.isOpen).toBe(false);
  });
});
