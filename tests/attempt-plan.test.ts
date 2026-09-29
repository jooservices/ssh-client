import { describe, expect, it } from 'vitest';
import { classifyConnectError, decideAttempt, type AttemptSnapshot, type TransportEvent } from '../src/attempt-plan.js';

const live: AttemptSnapshot = {
  tornDown: false,
  isInflight: true,
  inflightSettled: false,
  isActive: false,
};

const active: AttemptSnapshot = {
  tornDown: false,
  isInflight: false,
  inflightSettled: false,
  isActive: true,
};

describe('decideAttempt', () => {
  it('plans ready, shell, and transport events', () => {
    const timeout = 'ready prompt timed out after 1000ms';
    const cases: Array<{ snapshot: AttemptSnapshot; event: TransportEvent; effect: string }> = [
      {
        snapshot: { ...live, tornDown: true },
        event: { type: 'ready', remainingMs: 10, timeoutMessage: timeout },
        effect: 'ignore',
      },
      {
        snapshot: { ...live, isInflight: false },
        event: { type: 'ready', remainingMs: 10, timeoutMessage: timeout },
        effect: 'ignore',
      },
      {
        snapshot: { ...live, inflightSettled: true },
        event: { type: 'ready', remainingMs: 10, timeoutMessage: timeout },
        effect: 'ignore',
      },
      {
        snapshot: live,
        event: { type: 'ready', remainingMs: 0, timeoutMessage: timeout },
        effect: 'fail',
      },
      {
        snapshot: live,
        event: { type: 'ready', remainingMs: 5, timeoutMessage: timeout },
        effect: 'open-shell',
      },
      {
        snapshot: { ...live, tornDown: true },
        event: shell({ hasStream: true }),
        effect: 'close-own-stream',
      },
      {
        snapshot: { ...live, isInflight: false },
        event: shell({ hasStream: false }),
        effect: 'ignore',
      },
      {
        snapshot: live,
        event: shell({ failed: true, hasStream: true, failureMessage: 'pty failed' }),
        effect: 'fail',
      },
      {
        snapshot: live,
        event: shell({ failed: true, hasStream: false, failureMessage: 'shell failed' }),
        effect: 'fail',
      },
      {
        snapshot: live,
        event: shell({ remainingMs: 0 }),
        effect: 'fail',
      },
      {
        snapshot: live,
        event: shell({}),
        effect: 'attach-shell',
      },
      { snapshot: { ...live, tornDown: true }, event: { type: 'channel-gone' }, effect: 'ignore' },
      { snapshot: live, event: { type: 'channel-gone' }, effect: 'fail' },
      { snapshot: active, event: { type: 'client-close' }, effect: 'teardown' },
      {
        snapshot: { ...live, isInflight: false },
        event: { type: 'client-close' },
        effect: 'ignore',
      },
      {
        snapshot: { ...live, tornDown: true },
        event: { type: 'client-error', code: 'auth', message: 'nope' },
        effect: 'ignore',
      },
      {
        snapshot: live,
        event: { type: 'client-error', code: 'auth', message: 'bad password' },
        effect: 'fail',
      },
      {
        snapshot: active,
        event: { type: 'client-error', code: 'connect', message: 'reset' },
        effect: 'teardown',
      },
      {
        snapshot: { ...live, tornDown: true },
        event: { type: 'ready-result', code: 'timeout', message: timeout },
        effect: 'ignore',
      },
      {
        snapshot: live,
        event: { type: 'ready-result', code: 'invalid', message: 'too big' },
        effect: 'fail',
      },
      { snapshot: { ...active, tornDown: true }, event: { type: 'shell-dead' }, effect: 'ignore' },
      { snapshot: live, event: { type: 'shell-dead' }, effect: 'ignore' },
      { snapshot: active, event: { type: 'shell-dead' }, effect: 'teardown' },
    ];

    for (const entry of cases) {
      expect(decideAttempt(entry.snapshot, entry.event).type, JSON.stringify(entry.event)).toBe(entry.effect);
    }

    expect(decideAttempt(live, { type: 'ready', remainingMs: 0, timeoutMessage: timeout })).toMatchObject({
      type: 'fail',
      code: 'timeout',
      closeStream: false,
    });
    expect(
      decideAttempt(live, shell({ failed: true, hasStream: true, failureMessage: 'pty failed' })),
    ).toMatchObject({ type: 'fail', code: 'connect', message: 'pty failed', closeStream: true });
    expect(decideAttempt(live, { type: 'channel-gone' })).toMatchObject({
      code: 'connect',
      message: 'channel closed',
    });
  });
});

describe('classifyConnectError', () => {
  it('maps handshake timeout, authentication, and other connect failures', () => {
    expect(classifyConnectError('Timed out while waiting for handshake')).toBe('timeout');
    expect(classifyConnectError('All configured authentication methods failed')).toBe('auth');
    expect(classifyConnectError('password rejected')).toBe('auth');
    expect(classifyConnectError('credential rejected')).toBe('auth');
    expect(classifyConnectError('socket hang up')).toBe('connect');
  });
});

function shell(overrides: Partial<Extract<TransportEvent, { type: 'shell' }>>): TransportEvent {
  return {
    type: 'shell',
    hasStream: true,
    failed: false,
    remainingMs: 20,
    failureMessage: 'shell failed',
    timeoutMessage: 'ready prompt timed out after 1000ms',
    ...overrides,
  };
}
