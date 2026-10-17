import { describe, expect, it, vi } from 'vitest';
import type { SshErrorCode } from '../src/errors.js';
import type { AttemptSnapshot } from '../src/attempt-plan.js';
import { fingerprintSha256 } from '../src/host-key.js';
import { resolveOptions } from '../src/options.js';
import { SshSession } from '../src/session.js';
import { FakeSsh2Client } from './support/fake-ssh2.js';

interface TestAttempt {
  client: FakeSsh2Client;
  stream: FakeSsh2Client['channel'] | null;
  tornDown: boolean;
  clientEnded: boolean;
  endPromise?: Promise<void>;
  onReady: (...args: unknown[]) => void;
  onError: (...args: unknown[]) => void;
  onClose: (...args: unknown[]) => void;
  shellWindow: { term: string; rows: number; cols: number } | null;
}

interface TestSubscriber {
  settled: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface TestInflight {
  attempt: TestAttempt;
  subscribers: Set<TestSubscriber>;
  settled: boolean;
}

interface SessionInternals {
  createAttempt(): TestAttempt;
  subscribe(inflight: TestInflight, signal?: AbortSignal): Promise<void>;
  settleOne(subscriber: TestSubscriber, error?: Error): void;
  teardown(attempt: TestAttempt): void;
  endClient(attempt: TestAttempt): void;
  closeStream(stream?: { close(): void }): void;
  onClientReady(attempt: TestAttempt): void;
  finishOk(attempt: TestAttempt, inflight: TestInflight): void;
  failInflight(attempt: TestAttempt, code: SshErrorCode, message: string): void;
  apply(attempt: TestAttempt, effect: unknown): unknown;
  onShell(attempt: TestAttempt, error: Error | undefined, stream: FakeSsh2Client['channel']): void;
  snapshot(attempt: TestAttempt): AttemptSnapshot;
}

const hostKey = Buffer.from('session-internals-host-key');

function createSession(fake: FakeSsh2Client): SshSession {
  return new SshSession(
    resolveOptions({
      host: 'router.local',
      username: 'admin',
      password: 'secret',
      hostFingerprint: fingerprintSha256(hostKey),
      settleMs: 0,
    }),
    () => fake,
  );
}

function internals(session: SshSession): SessionInternals {
  return session as unknown as SessionInternals;
}

describe('SshSession lifecycle guards', () => {
  it('keeps attempt placeholders harmless and makes client shutdown idempotent', async () => {
    const fake = new FakeSsh2Client({ hostKey });
    const state = internals(createSession(fake));
    const attempt = state.createAttempt();

    attempt.onReady();
    attempt.onError(new Error('early'));
    attempt.onClose();
    expect(fake.connectConfig).toBeNull();
    expect(fake.endCount).toBe(0);

    state.endClient(attempt);
    state.endClient(attempt);
    await attempt.endPromise;
    expect(fake.endCount).toBe(1);
  });

  it('ignores a ready callback after teardown and tears down only once', async () => {
    const fake = new FakeSsh2Client({ hostKey });
    const state = internals(createSession(fake));
    const attempt = state.createAttempt();

    state.teardown(attempt);
    state.teardown(attempt);
    state.onClientReady(attempt);
    await attempt.endPromise;

    expect(attempt.tornDown).toBe(true);
    expect(fake.shellOptions).toBeNull();
    expect(fake.endCount).toBe(1);
  });

  it('rejects an unknown attempt effect instead of leaking it to the caller', () => {
    const state = internals(createSession(new FakeSsh2Client({ hostKey })));
    const attempt = state.createAttempt();

    expect(() => state.apply(attempt, { type: 'future-effect' })).toThrow('Unexpected SSH attempt effect: future-effect');
  });

  it('does not attach a shell callback after its inflight attempt is gone', () => {
    const fake = new FakeSsh2Client({ hostKey });
    const state = internals(createSession(fake));
    const attempt = state.createAttempt();

    vi.spyOn(state, 'snapshot').mockReturnValue({
      tornDown: false,
      isInflight: true,
      inflightSettled: false,
      isActive: false,
    });
    state.onShell(attempt, undefined, fake.channel);

    expect(fake.channel.listenerCount('data')).toBe(0);
    expect(attempt.stream).toBeNull();
  });

  it('rejects subscribers joining a settled connection attempt', async () => {
    const state = internals(createSession(new FakeSsh2Client({ hostKey })));
    const inflight: TestInflight = {
      attempt: state.createAttempt(),
      subscribers: new Set(),
      settled: true,
    };

    await expect(state.subscribe(inflight)).rejects.toMatchObject({ code: 'closed', message: 'disconnected' });
  });

  it('does not settle a subscriber twice', () => {
    const state = internals(createSession(new FakeSsh2Client({ hostKey })));
    const resolve = vi.fn();
    const reject = vi.fn();

    state.settleOne({ settled: true, resolve, reject }, new Error('already settled'));

    expect(resolve).not.toHaveBeenCalled();
    expect(reject).not.toHaveBeenCalled();
  });

  it('does not revive a stale connection attempt', () => {
    const state = internals(createSession(new FakeSsh2Client({ hostKey })));
    const attempt = state.createAttempt();
    const subscriber: TestSubscriber = { settled: false, resolve: vi.fn(), reject: vi.fn() };

    for (const stale of [
      { attempt: { ...attempt, tornDown: true }, subscribers: new Set([subscriber]), settled: false },
      { attempt, subscribers: new Set([subscriber]), settled: true },
      { attempt, subscribers: new Set([subscriber]), settled: false },
    ]) {
      state.finishOk(stale.attempt, stale);
    }

    expect(subscriber.resolve).not.toHaveBeenCalled();
    expect(subscriber.reject).not.toHaveBeenCalled();
  });

  it('tears down an active attempt after a late failure notification', async () => {
    const fake = new FakeSsh2Client({ hostKey });
    const session = createSession(fake);
    const state = internals(session);
    let active: TestAttempt | null = null;
    const originalFinish = state.finishOk.bind(session);
    const finish = vi.spyOn(state, 'finishOk').mockImplementation((attempt, inflight) => {
      active = attempt;
      originalFinish(attempt, inflight);
    });

    await session.connect();
    finish.mockRestore();
    expect(active).not.toBeNull();
    expect(session.isOpen).toBe(true);

    state.failInflight(active!, 'closed', 'late failure');
    await active!.endPromise;

    expect(session.isOpen).toBe(false);
    expect(fake.endCount).toBe(1);
  });

  it('preserves the last shell window when an attempt has no captured window', async () => {
    const fake = new FakeSsh2Client({ hostKey });
    const session = createSession(fake);
    const state = internals(session);
    const originalFinish = state.finishOk.bind(session);
    let finished = 0;
    const finish = vi.spyOn(state, 'finishOk').mockImplementation((attempt, inflight) => {
      finished += 1;

      if (finished === 2) {
        attempt.shellWindow = null;
      }

      originalFinish(attempt, inflight);
    });

    await session.connect();
    const shellWindow = session.shellWindow;
    await session.disconnect();
    await session.connect();

    expect(session.shellWindow).toBe(shellWindow);
    finish.mockRestore();
    await session.disconnect();
  });

  it('ignores a failure notification for an unrelated attempt', async () => {
    const fake = new FakeSsh2Client({ hostKey });
    const session = createSession(fake);
    const state = internals(session);
    const stale = state.createAttempt();

    await session.connect();
    state.failInflight(stale, 'closed', 'stale');

    expect(session.isOpen).toBe(true);
    expect(fake.endCount).toBe(0);
    await session.disconnect();
  });

  it('ignores a missing stream when closing a stale shell callback', () => {
    const state = internals(createSession(new FakeSsh2Client({ hostKey })));

    expect(() => state.closeStream(undefined)).not.toThrow();
  });
});
