import { describe, expect, it, vi } from 'vitest';
import type { PagerState } from '../src/pager.js';
import { ShellIo } from '../src/shell-io.js';
import { FakeSsh2Channel } from './support/fake-ssh2.js';

interface TestWaiter {
  mode: 'ready' | 'command' | 'resync';
  pager: PagerState;
  maxPages: number;
  maxOutputBytes: number;
  command: string;
  timer: ReturnType<typeof setTimeout>;
  settleTimer: ReturnType<typeof setTimeout> | null;
  pokeTimer: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  idleTimeoutMs: number;
  generation: number;
  settled: boolean;
  confirming: boolean;
  candidate: string;
  killSent: boolean;
  resolve: (value: string) => void;
  reject: (reason: Error) => void;
  onAbort?: () => void;
  signal?: AbortSignal;
}

interface ShellInternals {
  waiter: TestWaiter | null;
  resyncing: Promise<void> | null;
  detached: boolean;
  resyncFailed: boolean;
  finishWaiter(waiter: TestWaiter, settle: () => void): void;
  onSettled(waiter: TestWaiter, generation: number): void;
  resync(wasPaging: boolean): void;
  failWaiter(error: Error, resync: boolean): void;
  settleResync(waiter: TestWaiter, current: string, prompt: boolean): void;
}

const prompt = 'router# ';
const limits = { commandTimeoutMs: 500, maxPages: 2, maxOutputBytes: 1_000_000, settleMs: 0 };

function createIo(channel: FakeSsh2Channel): ShellIo {
  return new ShellIo(channel, { promptIdentity: prompt, settleMs: 0, idleBufferMaxBytes: 64_000 });
}

function internals(io: ShellIo): ShellInternals {
  return io as unknown as ShellInternals;
}

describe('ShellIo lifecycle guards', () => {
  it('ignores stale timeout callbacks and settles a waiter only once', async () => {
    vi.useFakeTimers();

    try {
      const channel = new FakeSsh2Channel({ prompt });
      const io = createIo(channel);
      const state = internals(io);
      const pending = io.runCommand('waiting', limits, { idleTimeoutMs: 10 });
      const waiter = state.waiter!;
      const current = { ...waiter, generation: waiter.generation + 1 };
      state.waiter = current;

      await vi.advanceTimersByTimeAsync(500);
      state.onSettled(waiter, waiter.generation);
      expect(state.waiter).toBe(current);

      const settle = vi.fn(() => waiter.resolve('settled'));
      state.finishWaiter(waiter, settle);
      state.finishWaiter(waiter, settle);
      await expect(pending).resolves.toBe('settled');
      expect(settle).toHaveBeenCalledOnce();

      state.waiter = null;
      io.detach();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not send a ready poke after prompt confirmation has started', async () => {
    vi.useFakeTimers();

    try {
      const channel = new FakeSsh2Channel({ prompt });
      const io = createIo(channel);
      const state = internals(io);
      const pending = io.waitForReady({
        settleMs: 0,
        timeoutMs: 2_000,
        timeoutMessage: 'ready prompt timed out',
        readyPoke: true,
        maxOutputBytes: 1_000_000,
      });
      const waiter = state.waiter!;
      waiter.confirming = true;
      waiter.candidate = prompt;

      await vi.advanceTimersByTimeAsync(500);
      expect(channel.writes).toEqual([]);

      channel.emitText(prompt);
      await vi.advanceTimersByTimeAsync(0);
      await expect(pending).resolves.toBe(prompt);
      io.detach();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not settle a command while its current line is not a prompt', async () => {
    const channel = new FakeSsh2Channel({ prompt });
    const io = createIo(channel);
    const state = internals(io);
    const pending = io.runCommand('waiting', limits);
    const waiter = state.waiter!;

    state.onSettled(waiter, waiter.generation);
    expect(state.waiter).toBe(waiter);

    channel.emitText(prompt);
    await expect(pending).resolves.toBe('');
    io.detach();
  });

  it('clears a prompt settle timer when a pager marker arrives on the same tail', async () => {
    vi.useFakeTimers();

    try {
      const channel = new FakeSsh2Channel({ prompt });
      const io = createIo(channel);
      const state = internals(io);
      const pending = io.runCommand('waiting', limits);
      const waiter = state.waiter!;

      channel.emitText(prompt);
      expect(waiter.settleTimer).not.toBeNull();
      channel.emitText('--- MORE ---');
      expect(waiter.settleTimer).toBeNull();

      io.detach();
      await expect(pending).rejects.toMatchObject({ code: 'closed' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores failure notifications with no waiter or an already settled waiter', async () => {
    const channel = new FakeSsh2Channel({ prompt });
    const io = createIo(channel);
    const state = internals(io);

    state.failWaiter(new Error('no waiter'), false);
    const pending = io.runCommand('waiting', limits);
    const waiter = state.waiter!;
    waiter.settled = true;
    state.failWaiter(new Error('already settled'), true);
    waiter.settled = false;
    io.detach();

    await expect(pending).rejects.toMatchObject({ code: 'closed' });
  });

  it('does not send a second kill line after the resync is already dirty', async () => {
    vi.useFakeTimers();

    try {
      const channel = new FakeSsh2Channel({ prompt, ignoreInterrupt: true });
      const io = createIo(channel);
      const state = internals(io);
      const pending = io.runCommand('stuck', { ...limits, commandTimeoutMs: 10 });
      const failure = expect(pending).rejects.toMatchObject({ code: 'timeout' });

      await vi.advanceTimersByTimeAsync(10);
      await failure;
      const waiter = state.waiter!;
      channel.emitText('partial');
      await vi.advanceTimersByTimeAsync(0);
      expect(waiter.killSent).toBe(true);
      const killWrites = channel.writes.filter((entry) => String(entry).includes('\u0015')).length;

      state.settleResync(waiter, 'still dirty', false);
      expect(channel.writes.filter((entry) => String(entry).includes('\u0015'))).toHaveLength(killWrites);

      await vi.advanceTimersByTimeAsync(5_000);
      io.detach();
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks recovery failed when pager quit and interrupt recovery both fail', async () => {
    vi.useFakeTimers();

    try {
      const channel = new FakeSsh2Channel({ prompt });
      const originalWrite = channel.write.bind(channel);
      channel.write = (data) => {
        const text = String(data);

        if (text === 'q') {
          channel.close();
          throw new Error('pager quit failed');
        }

        if (text.includes('\u0003')) {
          throw new Error('interrupt failed');
        }

        return originalWrite(data);
      };
      const io = createIo(channel);
      const pending = io.runCommand('paged', { ...limits, commandTimeoutMs: 10 });
      const failure = expect(pending).rejects.toMatchObject({ code: 'timeout' });

      channel.emitText('--- MORE ---');
      await vi.advanceTimersByTimeAsync(10);
      await failure;
      await vi.advanceTimersByTimeAsync(5_000);
      await Promise.resolve();
      await Promise.resolve();

      await expect(io.runCommand('after failure', limits)).rejects.toMatchObject({
        code: 'closed',
        message: 'resync failed',
      });
      io.detach();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rechecks detachment after waiting for a recovery already in progress', async () => {
    const io = createIo(new FakeSsh2Channel({ prompt }));
    const state = internals(io);
    state.resyncing = Promise.resolve().then(() => {
      state.detached = true;
    });

    await expect(io.runCommand('after recovery', limits)).rejects.toMatchObject({
      code: 'closed',
      message: 'resync failed',
    });
    state.detached = false;
    state.resyncing = null;
    io.detach();
  });

  it('prefers abort when an in-progress recovery rejects', async () => {
    const io = createIo(new FakeSsh2Channel({ prompt }));
    const state = internals(io);
    const controller = new AbortController();
    state.resyncing = Promise.resolve().then(() => {
      controller.abort();
      throw new Error('recovery failed');
    });

    await expect(io.runCommand('after recovery', limits, { signal: controller.signal })).rejects.toMatchObject({
      code: 'closed',
      message: 'aborted',
    });
    state.resyncing = null;
    io.detach();
  });

  it('does not start another recovery while one is already recorded', () => {
    const channel = new FakeSsh2Channel({ prompt });
    const io = createIo(channel);
    const state = internals(io);
    const pending = Promise.resolve();
    state.resyncing = pending;

    state.resync(false);

    expect(channel.writes).toEqual([]);
    expect(state.resyncing).toBe(pending);
    state.resyncing = null;
    io.detach();
  });

  it('keeps a newer recovery record when an older recovery finishes', async () => {
    vi.useFakeTimers();

    try {
      const channel = new FakeSsh2Channel({ prompt });
      const io = createIo(channel);
      const state = internals(io);
      state.resync(false);
      const newer = Promise.resolve();
      state.resyncing = newer;

      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      expect(state.resyncing).toBe(newer);
      state.resyncing = null;
      io.detach();
    } finally {
      vi.useRealTimers();
    }
  });
});
