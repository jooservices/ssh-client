import { Client } from 'ssh2';
import {
  classifyConnectError,
  decideAttempt,
  type AttemptEffect,
  type AttemptSnapshot,
} from './attempt-plan.js';
import { SshClientError, type SshErrorCode } from './errors.js';
import { hostKeyMatches } from './host-key.js';
import { ptyOptions, type ResolvedOptions } from './options.js';
import type { ShellPtyOptions } from './public-types.js';
import { ShellIo, type ShellStream } from './shell-io.js';

type ClientEvent = 'ready' | 'error' | 'close';
type ChannelEvent = 'close' | 'end' | 'error';
type ClientListener = (...args: unknown[]) => void;
type ChannelListener = (err?: unknown) => void;

export interface ShellChannelLike extends ShellStream {
  close: () => void;
  on(event: ChannelEvent, listener: ChannelListener): unknown;
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  removeListener(event: ChannelEvent, listener: ChannelListener): unknown;
  removeListener(event: 'data', listener: (chunk: Buffer) => void): unknown;
  write: (data: string | Buffer) => unknown;
}

export interface Ssh2ClientLike {
  on: (event: ClientEvent, listener: ClientListener) => Ssh2ClientLike;
  removeListener: (event: ClientEvent, listener: ClientListener) => Ssh2ClientLike;
  connect: (config: Ssh2ConnectConfig) => Ssh2ClientLike;
  shell: (
    window: ShellPtyOptions,
    callback: (err: Error | undefined, stream?: ShellChannelLike) => void,
  ) => void;
  end: () => void;
}

export interface Ssh2ConnectConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  readyTimeout: number;
  hostVerifier?: (key: Buffer) => boolean;
}

export type Ssh2ClientFactory = () => Ssh2ClientLike;

interface ConnectionAttempt {
  readonly id: number;
  readonly client: Ssh2ClientLike;
  readonly deadline: number;
  stream: ShellChannelLike | null;
  io: ShellIo | null;
  tornDown: boolean;
  clientEnded: boolean;
  shellTimer: ReturnType<typeof setTimeout> | null;
  removeAbort?: () => void;
  onReady: ClientListener;
  onError: ClientListener;
  onClose: ClientListener;
  onChannelGone?: ChannelListener;
}

interface Inflight {
  readonly attempt: ConnectionAttempt;
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (reason: Error) => void;
  settled: boolean;
}

export class SshSession {
  private active: ConnectionAttempt | null = null;
  private inflight: Inflight | null = null;
  private nextId = 0;
  private lastShellWindow: ShellPtyOptions | null = null;

  constructor(
    private readonly opts: ResolvedOptions,
    private readonly clientFactory: Ssh2ClientFactory = () => new Client() as unknown as Ssh2ClientLike,
  ) {}

  get isOpen(): boolean {
    const active = this.active;

    return active !== null && !active.tornDown && active.stream !== null && active.io !== null;
  }

  get shellWindow(): ShellPtyOptions | null {
    return this.lastShellWindow;
  }

  getIo(): ShellIo {
    if (!this.active?.io || this.active.tornDown) {
      throw new SshClientError('closed', 'not connected');
    }

    return this.active.io;
  }

  getStream(): ShellChannelLike {
    if (!this.active?.stream || this.active.tornDown) {
      throw new SshClientError('closed', 'not connected');
    }

    return this.active.stream;
  }

  connect(signal?: AbortSignal): Promise<void> {
    if (this.isOpen) {
      return Promise.resolve();
    }

    if (this.inflight) {
      return this.inflight.promise;
    }

    const attempt = this.createAttempt();
    let resolveInflight: () => void = () => undefined;
    let rejectInflight: (reason: Error) => void = () => undefined;
    const promise = new Promise<void>((resolve, reject) => {
      resolveInflight = resolve;
      rejectInflight = reject;
    });
    const inflight: Inflight = {
      attempt,
      promise,
      resolve: resolveInflight,
      reject: rejectInflight,
      settled: false,
    };

    this.inflight = inflight;
    this.openAttempt(attempt, signal);

    return promise;
  }

  async disconnect(): Promise<void> {
    const active = this.active;

    if (active?.stream && !active.tornDown) {
      try {
        active.stream.write('exit\r');
      } catch {
        /* best-effort exit */
      }
    }

    if (this.inflight && !this.inflight.settled) {
      this.failInflight(this.inflight.attempt, 'closed', 'disconnected during connect');
    }

    if (this.active && !this.active.tornDown) {
      this.teardown(this.active);
    }
  }

  private createAttempt(): ConnectionAttempt {
    return {
      id: ++this.nextId,
      client: this.clientFactory(),
      deadline: Date.now() + this.opts.readyTimeoutMs,
      stream: null,
      io: null,
      tornDown: false,
      clientEnded: false,
      shellTimer: null,
      onReady: () => undefined,
      onError: () => undefined,
      onClose: () => undefined,
    };
  }

  private remaining(attempt: ConnectionAttempt): number {
    return Math.max(0, attempt.deadline - Date.now());
  }

  private openAttempt(attempt: ConnectionAttempt, signal?: AbortSignal): void {
    attempt.onReady = (): void => {
      this.onClientReady(attempt);
    };
    attempt.onError = (err?: unknown): void => {
      this.onClientError(attempt, err);
    };
    attempt.onClose = (): void => {
      this.onClientClose(attempt);
    };

    attempt.client.on('ready', attempt.onReady);
    attempt.client.on('error', attempt.onError);
    attempt.client.on('close', attempt.onClose);

    if (signal) {
      const onAbort = (): void => {
        this.failInflight(attempt, 'closed', 'aborted');
      };

      if (signal.aborted) {
        this.failInflight(attempt, 'closed', 'aborted');
        return;
      }

      signal.addEventListener('abort', onAbort, { once: true });
      attempt.removeAbort = (): void => {
        signal.removeEventListener('abort', onAbort);
      };
    }

    attempt.client.connect(this.connectConfig());
  }

  private onClientReady(attempt: ConnectionAttempt): void {
    const effect = decideAttempt(this.snapshot(attempt), {
      type: 'ready',
      remainingMs: this.remaining(attempt),
      timeoutMessage: this.readyTimeoutMessage(),
    });

    if (effect.type === 'fail') {
      this.apply(attempt, effect);
      return;
    }

    if (effect.type !== 'open-shell') {
      return;
    }

    attempt.shellTimer = setTimeout(() => {
      this.failInflight(attempt, 'timeout', this.readyTimeoutMessage());
    }, this.remaining(attempt));

    const window = ptyOptions(this.opts);
    this.lastShellWindow = window;
    attempt.client.shell(window, (err, stream) => {
      this.onShell(attempt, err, stream);
    });
  }

  private onShell(attempt: ConnectionAttempt, err: Error | undefined, stream: ShellChannelLike | undefined): void {
    if (attempt.shellTimer) {
      clearTimeout(attempt.shellTimer);
      attempt.shellTimer = null;
    }

    const left = this.remaining(attempt);
    const effect = decideAttempt(this.snapshot(attempt), {
      type: 'shell',
      hasStream: stream !== undefined,
      failed: err !== undefined || stream === undefined,
      remainingMs: left,
      failureMessage: err?.message ?? 'shell failed',
      timeoutMessage: this.readyTimeoutMessage(),
    });

    if (effect.type !== 'attach-shell') {
      this.apply(attempt, effect, stream);
      return;
    }

    const inflight = this.inflight;

    if (!stream || !inflight) {
      return;
    }

    attempt.stream = stream;
    attempt.io = new ShellIo(stream, {
      promptRegex: this.opts.promptRegex,
      settleMs: this.opts.settleMs,
      idleBufferMaxBytes: this.opts.idleBufferMaxBytes,
      onDead: () => {
        this.apply(attempt, decideAttempt(this.snapshot(attempt), { type: 'shell-dead' }));
      },
    });

    const onChannelGone: ChannelListener = (): void => {
      this.apply(attempt, decideAttempt(this.snapshot(attempt), { type: 'channel-gone' }));
    };

    attempt.onChannelGone = onChannelGone;
    stream.on('close', onChannelGone);
    stream.on('end', onChannelGone);
    stream.on('error', onChannelGone);

    void attempt.io
      .waitForReady({
        promptRegex: this.opts.promptRegex,
        settleMs: this.opts.settleMs,
        timeoutMs: left,
        timeoutMessage: this.readyTimeoutMessage(),
        readyPoke: true,
        maxOutputBytes: this.opts.maxOutputBytes,
      })
      .then(() => {
        this.finishOk(attempt, inflight);
      })
      .catch((error: unknown) => {
        const code =
          error instanceof SshClientError && (error.code === 'timeout' || error.code === 'invalid')
            ? error.code
            : 'connect';
        const message = error instanceof SshClientError ? error.message : errorMessage(error);

        this.apply(
          attempt,
          decideAttempt(this.snapshot(attempt), { type: 'ready-result', code, message }),
        );
      });
  }

  private onClientError(attempt: ConnectionAttempt, err: unknown): void {
    const message = errorMessage(err);

    this.apply(
      attempt,
      decideAttempt(this.snapshot(attempt), {
        type: 'client-error',
        code: classifyConnectError(message),
        message,
      }),
    );
  }

  private onClientClose(attempt: ConnectionAttempt): void {
    this.apply(attempt, decideAttempt(this.snapshot(attempt), { type: 'client-close' }));
  }

  private snapshot(attempt: ConnectionAttempt): AttemptSnapshot {
    const inflight = this.inflight?.attempt === attempt ? this.inflight : null;

    return {
      tornDown: attempt.tornDown,
      isInflight: inflight !== null,
      inflightSettled: inflight?.settled ?? false,
      isActive: this.active === attempt,
    };
  }

  private apply(attempt: ConnectionAttempt, effect: AttemptEffect, stream?: ShellChannelLike): void {
    switch (effect.type) {
      case 'ignore':
      case 'open-shell':
      case 'attach-shell':
        return;
      case 'close-own-stream':
        this.closeStream(stream);
        return;
      case 'fail':
        if (effect.closeStream) {
          this.closeStream(stream);
        }

        this.failInflight(attempt, effect.code, effect.message);
        return;
      case 'teardown':
        this.teardown(attempt);
        return;
      default: {
        const unreachable: never = effect;

        return unreachable;
      }
    }
  }

  private closeStream(stream: ShellChannelLike | undefined): void {
    if (!stream) {
      return;
    }

    try {
      stream.close();
    } catch {
      /* stale or failed shell */
    }
  }

  private finishOk(attempt: ConnectionAttempt, inflight: Inflight): void {
    if (attempt.tornDown || inflight.settled || this.inflight !== inflight) {
      return;
    }

    inflight.settled = true;
    attempt.removeAbort?.();
    attempt.removeAbort = undefined;
    this.inflight = null;
    this.active = attempt;
    inflight.resolve();
  }

  private failInflight(attempt: ConnectionAttempt, code: SshErrorCode, message: string): void {
    const inflight = this.inflight?.attempt === attempt ? this.inflight : null;

    if (inflight && !inflight.settled) {
      inflight.settled = true;
      this.teardown(attempt);
      inflight.reject(new SshClientError(code, message));
      return;
    }

    if (this.active === attempt && !attempt.tornDown) {
      this.teardown(attempt);
    }
  }

  private teardown(attempt: ConnectionAttempt): void {
    if (attempt.tornDown) {
      return;
    }

    attempt.tornDown = true;
    attempt.io?.detach();
    attempt.io = null;
    attempt.client.removeListener('ready', attempt.onReady);
    attempt.client.removeListener('error', attempt.onError);
    attempt.client.removeListener('close', attempt.onClose);

    const stream = attempt.stream;

    if (stream && attempt.onChannelGone) {
      stream.removeListener('close', attempt.onChannelGone);
      stream.removeListener('end', attempt.onChannelGone);
      stream.removeListener('error', attempt.onChannelGone);
    }

    if (attempt.shellTimer) {
      clearTimeout(attempt.shellTimer);
      attempt.shellTimer = null;
    }

    attempt.removeAbort?.();
    attempt.removeAbort = undefined;

    // ssh2 emits `error` after `end()` returns. Removing this listener makes that error uncaught.
    const swallow: ClientListener = (): void => undefined;
    attempt.client.on('error', swallow);

    if (stream) {
      try {
        stream.close();
      } catch {
        /* ignore */
      }
    }

    this.endClient(attempt);
    attempt.stream = null;

    if (this.active === attempt) {
      this.active = null;
    }

    if (this.inflight?.attempt === attempt) {
      this.inflight = null;
    }
  }

  private endClient(attempt: ConnectionAttempt): void {
    if (attempt.clientEnded) {
      return;
    }

    attempt.clientEnded = true;

    try {
      attempt.client.end();
    } catch {
      /* ignore */
    }
  }

  private readyTimeoutMessage(): string {
    return `ready prompt timed out after ${this.opts.readyTimeoutMs}ms`;
  }

  private connectConfig(): Ssh2ConnectConfig {
    const config: Ssh2ConnectConfig = {
      host: this.opts.host,
      port: this.opts.port,
      username: this.opts.username,
      password: this.opts.password,
      readyTimeout: this.opts.readyTimeoutMs,
    };

    if (!this.opts.insecureSkipVerify) {
      config.hostVerifier = (key: Buffer): boolean => hostKeyMatches(this.opts.hostFingerprint!, key);
    }

    return config;
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }

  return String(err);
}
