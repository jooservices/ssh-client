import { messageOf, type SshErrorCode } from './errors.js';

/** What the session knows about one attempt when an event arrives. */
export interface AttemptSnapshot {
  tornDown: boolean;
  /** This attempt is the current in-flight connect, settled or not. */
  isInflight: boolean;
  inflightSettled: boolean;
  isActive: boolean;
}

export type TransportEvent =
  | { type: 'ready'; remainingMs: number; timeoutMessage: string }
  | {
      type: 'shell';
      hasStream: boolean;
      failed: boolean;
      remainingMs: number;
      failureMessage: string;
      timeoutMessage: string;
    }
  | { type: 'channel-gone' }
  | { type: 'client-error'; code: SshErrorCode; message: string }
  | { type: 'client-close' }
  | { type: 'ready-result'; code: SshErrorCode; message: string }
  | { type: 'shell-dead' };

export type AttemptEffect =
  | { type: 'ignore' }
  | { type: 'open-shell' }
  | { type: 'attach-shell' }
  | { type: 'close-own-stream' }
  | { type: 'fail'; code: SshErrorCode; message: string; closeStream: boolean }
  | { type: 'teardown' };

/**
 * Pure plan for one SSH attempt. `SshSession` performs the effect.
 * Ready and shell events belong only to the unsettled in-flight attempt.
 */
export function decideAttempt(snapshot: AttemptSnapshot, event: TransportEvent): AttemptEffect {
  switch (event.type) {
    case 'ready':
      if (isStaleConnect(snapshot)) {
        return { type: 'ignore' };
      }

      if (event.remainingMs === 0) {
        return fail('timeout', event.timeoutMessage, false);
      }

      return { type: 'open-shell' };
    case 'shell':
      if (isStaleConnect(snapshot)) {
        return event.hasStream ? { type: 'close-own-stream' } : { type: 'ignore' };
      }

      if (event.failed) {
        return fail('connect', event.failureMessage, event.hasStream);
      }

      if (event.remainingMs === 0) {
        return fail('timeout', event.timeoutMessage, true);
      }

      return { type: 'attach-shell' };
    case 'channel-gone':
    case 'client-close':
      return settleLive(snapshot, 'connect', 'channel closed');
    case 'client-error':
      return settleLive(snapshot, event.code, event.message);
    case 'ready-result':
      if (isStaleConnect(snapshot)) {
        return { type: 'ignore' };
      }

      return fail(event.code, event.message, false);
    case 'shell-dead':
      if (snapshot.tornDown || !snapshot.isActive) {
        return { type: 'ignore' };
      }

      return { type: 'teardown' };
    default: {
      const unreachable: never = event;

      return unreachable;
    }
  }
}

export function classifyConnectError(
  err: unknown,
  hostKeyRejected = false,
): 'connect' | 'auth' | 'timeout' | 'hostkey' {
  if (hostKeyRejected) {
    return 'hostkey';
  }

  const level = levelOf(err);

  if (level === 'client-authentication' || level === 'agent') {
    return 'auth';
  }

  if (level === 'client-timeout') {
    return 'timeout';
  }

  if (level === 'client-socket' || level === 'handshake' || level === 'protocol') {
    return 'connect';
  }

  const message = typeof err === 'string' ? err : messageOf(err);

  if (/timed out/i.test(message)) {
    return 'timeout';
  }

  if (/auth|password|credential/i.test(message)) {
    return 'auth';
  }

  return 'connect';
}

function levelOf(err: unknown): string {
  if (typeof err !== 'object' || err === null || !('level' in err)) {
    return '';
  }

  const level = err.level;

  return typeof level === 'string' ? level : '';
}

function isStaleConnect(snapshot: AttemptSnapshot): boolean {
  return snapshot.tornDown || !snapshot.isInflight || snapshot.inflightSettled;
}

function settleLive(snapshot: AttemptSnapshot, code: SshErrorCode, message: string): AttemptEffect {
  if (snapshot.tornDown) {
    return { type: 'ignore' };
  }

  if (snapshot.isInflight && !snapshot.inflightSettled) {
    return fail(code, message, false);
  }

  if (snapshot.isActive) {
    return { type: 'teardown' };
  }

  return { type: 'ignore' };
}

function fail(code: SshErrorCode, message: string, closeStream: boolean): AttemptEffect {
  return { type: 'fail', code, message, closeStream };
}
