import { describe, expect, it, vi } from 'vitest';
import { fingerprintSha256 } from '../src/host-key.js';
import { resolveOptions } from '../src/options.js';
import type { SshClientOptions } from '../src/public-types.js';
import { SshSession } from '../src/session.js';
import { FakeSsh2Client } from './support/fake-ssh2.js';

const hostKey = Buffer.from('session-race-host-key');

function sessionWith(fake: FakeSsh2Client, overrides: Partial<SshClientOptions> = {}): SshSession {
  return new SshSession(
    resolveOptions({
      ...overrides,
      host: overrides.host ?? 'router.local',
      username: overrides.username ?? 'admin',
      password: overrides.password ?? 'secret',
      hostFingerprint: Object.hasOwn(overrides, 'hostFingerprint')
        ? overrides.hostFingerprint
        : fingerprintSha256(hostKey),
      settleMs: overrides.settleMs ?? 0,
    }),
    () => fake,
  );
}

describe('SshSession races', () => {
  it('concurrent connect shares one attempt', async () => {
    const fake = new FakeSsh2Client({ hostKey });
    let created = 0;
    const session = new SshSession(
      resolveOptions({
        host: 'router.local',
        username: 'admin',
        password: 'secret',
        hostFingerprint: fingerprintSha256(hostKey),
        settleMs: 0,
      }),
      () => {
        created += 1;
        return fake;
      },
    );

    await Promise.all([session.connect(), session.connect()]);

    expect(created).toBe(1);
    expect(session.isOpen).toBe(true);
    expect(fake.endCount).toBe(0);
  });

  it('failed attempt then success', async () => {
    const failed = new FakeSsh2Client({ hostKey, connectError: new Error('network unreachable') });
    const ready = new FakeSsh2Client({ hostKey });
    const fakes = [failed, ready];
    let index = 0;
    const session = new SshSession(
      resolveOptions({
        host: 'router.local',
        username: 'admin',
        password: 'secret',
        hostFingerprint: fingerprintSha256(hostKey),
        settleMs: 0,
      }),
      () => fakes[index++]!,
    );

    await expect(session.connect()).rejects.toMatchObject({ code: 'connect', message: 'network unreachable' });
    await session.connect();

    expect(session.isOpen).toBe(true);
    expect(session.getStream()).toBe(ready.channel);
  });

  it('maps a handshake timeout message to timeout', async () => {
    const fake = new FakeSsh2Client({
      hostKey,
      connectError: new Error('Timed out while waiting for handshake'),
    });
    const session = sessionWith(fake);

    await expect(session.connect()).rejects.toMatchObject({ code: 'timeout' });
    expect(fake.ended).toBe(true);
  });

  it('handshake consumes the budget', async () => {
    vi.useFakeTimers();

    try {
      const fake = new FakeSsh2Client({ hostKey, deferConnect: true, shellImmediate: true });
      const session = sessionWith(fake, { readyTimeoutMs: 1_000 });
      const pending = session.connect();
      const assertion = expect(pending).rejects.toMatchObject({ code: 'timeout' });

      await vi.advanceTimersByTimeAsync(1_000);
      fake.releaseConnect();
      await assertion;
      expect(fake.shellOptions).toBeNull();
      expect(session.isOpen).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('prompt gets only the remainder', async () => {
    vi.useFakeTimers();

    try {
      const fake = new FakeSsh2Client({
        hostKey,
        deferConnect: true,
        shellImmediate: true,
        ignoreBareCr: true,
        initialPromptDelayMs: 10_000,
      });
      const session = sessionWith(fake, { readyTimeoutMs: 1_000 });
      const pending = session.connect();
      const assertion = expect(pending).rejects.toMatchObject({ code: 'timeout' });

      await vi.advanceTimersByTimeAsync(700);
      fake.releaseConnect();
      await vi.advanceTimersByTimeAsync(300);
      await assertion;
      expect(fake.shellOptions).not.toBeNull();
      expect(session.isOpen).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shell open has a deadline', async () => {
    const fake = new FakeSsh2Client({ hostKey, deferShell: true });
    const session = sessionWith(fake, { readyTimeoutMs: 40 });
    const pending = session.connect();

    await expect(pending).rejects.toMatchObject({ code: 'timeout' });
    fake.releaseShell();

    expect(session.isOpen).toBe(false);
    expect(fake.endCount).toBe(1);
  });

  it('rejects an already aborted signal before connect', async () => {
    const fake = new FakeSsh2Client({ hostKey });
    const session = sessionWith(fake);
    const controller = new AbortController();

    controller.abort();

    await expect(session.connect(controller.signal)).rejects.toMatchObject({
      code: 'closed',
      message: 'aborted',
    });
    expect(fake.connectConfig).toBeNull();
    expect(fake.ended).toBe(true);
    expect(session.isOpen).toBe(false);
  });

  it('abort during connect', async () => {
    const fake = new FakeSsh2Client({ hostKey, deferConnect: true });
    const session = sessionWith(fake);
    const controller = new AbortController();
    const pending = session.connect(controller.signal);

    controller.abort();
    fake.releaseConnect();

    await expect(pending).rejects.toMatchObject({ code: 'closed', message: 'aborted' });
    expect(fake.ended).toBe(true);
    expect(session.isOpen).toBe(false);
  });

  it('stale shell callback does not clear the new session', async () => {
    const first = new FakeSsh2Client({ hostKey, deferShell: true });
    const second = new FakeSsh2Client({ hostKey });
    const fakes = [first, second];
    let index = 0;
    const session = new SshSession(
      resolveOptions({
        host: 'router.local',
        username: 'admin',
        password: 'secret',
        hostFingerprint: fingerprintSha256(hostKey),
        settleMs: 0,
      }),
      () => fakes[index++]!,
    );
    const pending = session.connect();

    await new Promise((resolve) => setImmediate(resolve));
    await session.disconnect();
    await expect(pending).rejects.toMatchObject({ message: /disconnected during connect/u });
    await session.connect();
    first.releaseShell();

    expect(session.isOpen).toBe(true);
    expect(session.getStream()).toBe(second.channel);
  });

  it('stale client close does not detach the new shell', async () => {
    const first = new FakeSsh2Client({ hostKey });
    const second = new FakeSsh2Client({ hostKey });
    const fakes = [first, second];
    let index = 0;
    const session = new SshSession(
      resolveOptions({
        host: 'router.local',
        username: 'admin',
        password: 'secret',
        hostFingerprint: fingerprintSha256(hostKey),
        settleMs: 0,
      }),
      () => fakes[index++]!,
    );

    await session.connect();
    await session.disconnect();
    await session.connect();
    first.emitClose();

    expect(session.isOpen).toBe(true);
    expect(session.getStream()).toBe(second.channel);
    expect(second.endCount).toBe(0);
  });

  it('closes the shell stream when open fails with a stream', async () => {
    const fake = new FakeSsh2Client({
      hostKey,
      shellError: new Error('pty failed'),
      shellErrorWithStream: true,
    });
    const session = sessionWith(fake);

    await expect(session.connect()).rejects.toMatchObject({ code: 'connect', message: 'pty failed' });
    expect(fake.channel.closed).toBe(true);
    expect(session.isOpen).toBe(false);
    expect(fake.ended).toBe(true);
  });

  it('reports shell failed when the callback has no error and no stream', async () => {
    const fake = new FakeSsh2Client({ hostKey, shellMissing: true });
    const session = sessionWith(fake);

    await expect(session.connect()).rejects.toMatchObject({ code: 'connect', message: 'shell failed' });
    expect(session.isOpen).toBe(false);
    expect(fake.ended).toBe(true);
  });

  it('stale shell callback without a stream is ignored', async () => {
    const first = new FakeSsh2Client({
      hostKey,
      deferShell: true,
      shellError: new Error('shell open failed'),
    });
    const second = new FakeSsh2Client({ hostKey });
    const fakes = [first, second];
    let index = 0;
    const session = new SshSession(
      resolveOptions({
        host: 'router.local',
        username: 'admin',
        password: 'secret',
        hostFingerprint: fingerprintSha256(hostKey),
        settleMs: 0,
      }),
      () => fakes[index++]!,
    );
    const pending = session.connect();

    await new Promise((resolve) => setImmediate(resolve));
    await session.disconnect();
    await expect(pending).rejects.toMatchObject({ message: /disconnected during connect/u });
    await session.connect();
    first.releaseShell();

    expect(session.isOpen).toBe(true);
    expect(session.getStream()).toBe(second.channel);
  });

  it('client close while idle tears the session down', async () => {
    const fake = new FakeSsh2Client({ hostKey });
    const session = sessionWith(fake);

    await session.connect();
    fake.emitClose();

    expect(session.isOpen).toBe(false);
    expect(fake.ended).toBe(true);
    expect(fake.endCount).toBe(1);
  });

  it('client close during connect rejects the attempt', async () => {
    const fake = new FakeSsh2Client({ hostKey, deferConnect: true });
    const session = sessionWith(fake);
    const pending = session.connect();
    const assertion = expect(pending).rejects.toMatchObject({ code: 'connect', message: 'channel closed' });

    fake.emitClose();
    await assertion;
    expect(session.isOpen).toBe(false);
    expect(fake.ended).toBe(true);
  });

  it('client error while idle', async () => {
    const fake = new FakeSsh2Client({ hostKey });
    const session = sessionWith(fake);

    await session.connect();
    fake.emitClientError(new Error('late socket'));

    expect(session.isOpen).toBe(false);
    expect(fake.ended).toBe(true);
  });

  it('client error during exec', async () => {
    const fake = new FakeSsh2Client({ hostKey });
    const session = sessionWith(fake);

    await session.connect();
    const pending = session.getIo().runCommand('show', {
      commandTimeoutMs: 1_000,
      maxPages: 2,
      maxOutputBytes: 1_000,
      settleMs: 0,
    });

    fake.emitClientError(new Error('dropped'));

    await expect(pending).rejects.toMatchObject({ code: 'closed' });
    expect(session.isOpen).toBe(false);
    expect(fake.endCount).toBe(1);
  });

  it('channel close ends transport', async () => {
    const fake = new FakeSsh2Client({ hostKey });
    const session = sessionWith(fake);

    await session.connect();
    fake.channel.close();

    expect(session.isOpen).toBe(false);
    expect(fake.endCount).toBe(1);
  });

  it('channel end ends transport', async () => {
    const fake = new FakeSsh2Client({ hostKey });
    const session = sessionWith(fake);

    await session.connect();
    fake.channel.emitEnd();

    expect(session.isOpen).toBe(false);
    expect(fake.endCount).toBe(1);
  });

  it('channel error ends transport', async () => {
    const fake = new FakeSsh2Client({ hostKey });
    const session = sessionWith(fake);

    await session.connect();
    fake.channel.emitChannelError(new Error('broken'));

    expect(session.isOpen).toBe(false);
    expect(fake.endCount).toBe(1);
  });

  it('disconnect is idempotent', async () => {
    const fake = new FakeSsh2Client({ hostKey });
    const session = sessionWith(fake);

    await session.connect();
    await session.disconnect();
    await session.disconnect();

    expect(session.isOpen).toBe(false);
    expect(fake.endCount).toBe(1);
  });

  it('disconnect before ready ends the inflight client', async () => {
    const fake = new FakeSsh2Client({ hostKey, deferShell: true });
    const session = sessionWith(fake);
    const pending = session.connect();

    await new Promise((resolve) => setImmediate(resolve));
    await session.disconnect();
    await expect(pending).rejects.toMatchObject({ message: /disconnected during connect/u });
    fake.releaseShell();

    expect(fake.endCount).toBe(1);
    expect(session.isOpen).toBe(false);
  });

  it('oversized ready banner', async () => {
    const fake = new FakeSsh2Client({ hostKey, banner: 'x'.repeat(40) });
    const session = sessionWith(fake, { maxOutputBytes: 8 });

    await expect(session.connect()).rejects.toMatchObject({
      code: 'invalid',
      message: 'command output exceeded maxOutputBytes=8',
    });
    expect(session.isOpen).toBe(false);
    expect(fake.ended).toBe(true);
  });

  it('ready timeout', async () => {
    const fake = new FakeSsh2Client({ hostKey, initialPromptDelayMs: 5_000, ignoreBareCr: true });
    const session = sessionWith(fake, { readyTimeoutMs: 40 });

    await expect(session.connect()).rejects.toMatchObject({
      code: 'timeout',
      message: /ready prompt timed out after 40ms/u,
    });
    expect(session.isOpen).toBe(false);
  });

  it('ignores a client error emitted after teardown', async () => {
    const fake = new FakeSsh2Client({ hostKey });
    const session = sessionWith(fake);

    await session.connect();

    const originalEnd = fake.end.bind(fake);
    fake.end = (): void => {
      originalEnd();
      setTimeout(() => {
        fake.emit('error', new Error('Connection lost before handshake'));
      }, 0);
    };

    await session.disconnect();
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });

    expect(session.isOpen).toBe(false);
    expect(fake.listenerCount('error')).toBe(1);
  });
});
