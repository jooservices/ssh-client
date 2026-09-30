import { Client } from 'ssh2';
import {
  classifyConnectError,
  decideAttempt,
  type AttemptEffect,
  type AttemptSnapshot,
} from './attempt-plan.js';
import { messageOf, SshClientError, type SshErrorCode } from './errors.js';
import { hostKeyMatches } from './host-key.js';
import { ptyOptions, type ResolvedOptions } from './options.js';
import type { ShellPtyOptions } from './public-types.js';
import { ShellIo, type ShellStream } from './shell-io.js';

type ClientEvent = 'ready' | 'error' | 'close';
type ChannelEvent = 'close' | 'end' | 'error';
type ClientListener = (...args: unknown[]) => void;
type ChannelListener = (err?: unknown) => void;

const CLOSE_WAIT_MS = 1_000;
const READY_PASSTHROUGH = new Set<SshErrorCode>(['timeout', 'invalid', 'limit', 'hostkey']);

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
  hostKeyRejected: boolean;
  shellWindow: ShellPtyOptions | null;
  shellTimer: ReturnType<typeof setTimeout> | null;
  endPromise?: Promise<void>;
  onReady: ClientListener;
  onError: ClientListener;
  onClose: ClientListener;
  onChannelGone?: ChannelListener;
}

interface Subscriber {
  resolve: () => void;
  reject: (reason: Error) => void;
  settled: boolean;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface Inflight {
  readonly attempt: ConnectionAttempt;
  readonly subscribers: Set<Subscriber>;
  settled: boolean;
}

export class SshSession {
  readonly #opts: ResolvedOptions;
  readonly #clientFactory: Ssh2ClientFactory;
  #active: ConnectionAttempt | null = null;
  #inflight: Inflight | null = null;
  #nextId = 0;
  #lastShellWindow: ShellPtyOptions | null = null;

  constructor(
    opts: ResolvedOptions,
    clientFactory: Ssh2ClientFactory = () => new Client() as unknown as Ssh2ClientLike,
  ) {
    this.#opts = opts;
    this.#clientFactory = clientFactory;
  }

  get isOpen(): boolean {
    const active = this.#active;

    return active !== null && !active.tornDown && active.stream !== null && active.io !== null;
  }

  get shellWindow(): ShellPtyOptions | null {
    return this.#lastShellWindow;
  }

  getIo(): ShellIo {
    if (!this.#active?.io || this.#active.tornDown) {
      throw new SshClientError('closed', 'not connected');
    }

    return this.#active.io;
  }

  getStream(): ShellChannelLike {
    if (!this.#active?.stream || this.#active.tornDown) {
      throw new SshClientError('closed', 'not connected');
    }

    return this.#active.stream;
  }

  connect(signal?: AbortSignal): Promise<void> {
    if (this.isOpen) {
      return Promise.resolve();
    }

    if (this.#inflight) {
      return this.subscribe(this.#inflight, signal);
    }

    if (signal?.aborted) {
      // The caller never reaches connect(), but the attempt still has to be ended.
      const attempt = this.createAttempt();
      this.teardown(attempt);
      return Promise.reject(new SshClientError('closed', 'aborted'));
    }

    const attempt = this.createAttempt();
    const inflight: Inflight = { attempt, subscribers: new Set(), settled: false };
    this.#inflight = inflight;
    const promise = this.subscribe(inflight, signal);

    if (inflight.subscribers.size === 0) {
      this.#inflight = null;
      return promise;
    }

    this.openAttempt(attempt);

    return promise;
  }

  async disconnect(): Promise<void> {
    const attempts: ConnectionAttempt[] = [];

    if (this.#inflight && !this.#inflight.settled) {
      attempts.push(this.#inflight.attempt);
      this.failInflight(this.#inflight.attempt, 'closed', 'disconnected during connect');
    }

    if (this.#active && !this.#active.tornDown) {
      attempts.push(this.#active);
      this.teardown(this.#active);
    }

    await Promise.all(attempts.map((attempt) => attempt.endPromise ?? Promise.resolve()));
  }

  private createAttempt(): ConnectionAttempt {
    return {
      id: ++this.#nextId,
      client: this.#clientFactory(),
      deadline: performance.now() + this.#opts.readyTimeoutMs,
      stream: null,
      io: null,
      tornDown: false,
      clientEnded: false,
      hostKeyRejected: false,
      shellWindow: null,
      shellTimer: null,
      onReady: () => undefined,
      onError: () => undefined,
      onClose: () => undefined,
    };
  }

  private remaining(attempt: ConnectionAttempt): number {
    return Math.max(0, attempt.deadline - performance.now());
  }

  private subscribe(inflight: Inflight, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (inflight.settled) {
        reject(new SshClientError('closed', 'disconnected'));
        return;
      }

      if (signal?.aborted) {
        reject(new SshClientError('closed', 'aborted'));
        return;
      }

      const subscriber: Subscriber = { resolve, reject, settled: false, signal };
      const onAbort = (): void => {
        this.onSubscriberAbort(inflight, subscriber);
      };

      subscriber.onAbort = onAbort;
      inflight.subscribers.add(subscriber);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private onSubscriberAbort(inflight: Inflight, subscriber: Subscriber): void {
    this.settleOne(subscriber, new SshClientError('closed', 'aborted'));
    inflight.subscribers.delete(subscriber);

    if (!inflight.settled && inflight.subscribers.size === 0) {
      this.failInflight(inflight.attempt, 'closed', 'aborted');
    }
  }

  private openAttempt(attempt: ConnectionAttempt): void {
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
    attempt.client.connect(this.connectConfig(attempt));
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

    const window = ptyOptions(this.#opts);
    attempt.shellWindow = window;
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

    const inflight = this.#inflight;

    if (!stream || !inflight) {
      return;
    }

    attempt.stream = stream;
    attempt.io = new ShellIo(stream, {
      promptRegex: this.#opts.promptRegex,
      settleMs: this.#opts.settleMs,
      idleBufferMaxBytes: this.#opts.idleBufferMaxBytes,
      maxPromptLength: this.#opts.maxPromptLength,
      maxOutputBytes: this.#opts.maxOutputBytes,
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
        promptRegex: this.#opts.promptRegex,
        settleMs: this.#opts.settleMs,
        timeoutMs: left,
        timeoutMessage: this.readyTimeoutMessage(),
        readyPoke: true,
        maxOutputBytes: this.#opts.maxOutputBytes,
      })
      .then(() => {
        this.finishOk(attempt, inflight);
      })
      .catch((error: unknown) => {
        const code = error instanceof SshClientError && READY_PASSTHROUGH.has(error.code) ? error.code : 'connect';
        const message = error instanceof SshClientError ? error.message : messageOf(error);

        this.apply(attempt, decideAttempt(this.snapshot(attempt), { type: 'ready-result', code, message }));
      });
  }

  private onClientError(attempt: ConnectionAttempt, err: unknown): void {
    const message = messageOf(err);
    const effect = decideAttempt(this.snapshot(attempt), {
      type: 'client-error',
      code: classifyConnectError(err, attempt.hostKeyRejected),
      message,
    });

    if (effect.type === 'fail') {
      this.failInflight(attempt, effect.code, effect.message, err);
      return;
    }

    this.apply(attempt, effect);
  }

  private onClientClose(attempt: ConnectionAttempt): void {
    this.apply(attempt, decideAttempt(this.snapshot(attempt), { type: 'client-close' }));
  }

  private snapshot(attempt: ConnectionAttempt): AttemptSnapshot {
    const inflight = this.#inflight?.attempt === attempt ? this.#inflight : null;

    return {
      tornDown: attempt.tornDown,
      isInflight: inflight !== null,
      inflightSettled: inflight?.settled ?? false,
      isActive: this.#active === attempt,
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
    if (attempt.tornDown || inflight.settled || this.#inflight !== inflight) {
      return;
    }

    inflight.settled = true;
    this.#inflight = null;
    this.#active = attempt;

    if (attempt.shellWindow) {
      this.#lastShellWindow = attempt.shellWindow;
    }

    for (const subscriber of [...inflight.subscribers]) {
      this.settleOne(subscriber);
    }

    inflight.subscribers.clear();
  }

  private failInflight(attempt: ConnectionAttempt, code: SshErrorCode, message: string, cause?: unknown): void {
    const inflight = this.#inflight?.attempt === attempt ? this.#inflight : null;

    if (inflight && !inflight.settled) {
      inflight.settled = true;
      const error = new SshClientError(code, message, cause === undefined ? undefined : { cause });
      const subscribers = [...inflight.subscribers];
      inflight.subscribers.clear();
      this.teardown(attempt);

      for (const subscriber of subscribers) {
        this.settleOne(subscriber, error);
      }

      return;
    }

    if (this.#active === attempt && !attempt.tornDown) {
      this.teardown(attempt);
    }
  }

  private settleOne(subscriber: Subscriber, error?: Error): void {
    if (subscriber.settled) {
      return;
    }

    subscriber.settled = true;

    if (subscriber.signal && subscriber.onAbort) {
      subscriber.signal.removeEventListener('abort', subscriber.onAbort);
    }

    if (error) {
      subscriber.reject(error);
      return;
    }

    subscriber.resolve();
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

    // ssh2 emits `error` after `end()` returns. Keep this listener.
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

    if (this.#active === attempt) {
      this.#active = null;
    }

    if (this.#inflight?.attempt === attempt) {
      this.#inflight = null;
    }
  }

  private endClient(attempt: ConnectionAttempt): void {
    if (attempt.clientEnded) {
      return;
    }

    attempt.clientEnded = true;
    attempt.endPromise = new Promise<void>((resolve) => {
      let finished = false;
      const finish = (): void => {
        if (finished) {
          return;
        }

        finished = true;
        clearTimeout(timer);
        attempt.client.removeListener('close', onClose);
        resolve();
      };
      const onClose: ClientListener = (): void => {
        finish();
      };
      const timer = setTimeout(finish, CLOSE_WAIT_MS);

      attempt.client.on('close', onClose);

      try {
        attempt.client.end();
      } catch {
        finish();
      }
    });
  }

  private readyTimeoutMessage(): string {
    return `ready prompt timed out after ${this.#opts.readyTimeoutMs}ms`;
  }

  private connectConfig(attempt: ConnectionAttempt): Ssh2ConnectConfig {
    const config: Ssh2ConnectConfig = {
      host: this.#opts.host,
      port: this.#opts.port,
      username: this.#opts.username,
      password: this.#opts.password,
      readyTimeout: this.#opts.readyTimeoutMs,
    };

    if (!this.#opts.insecureSkipVerify && this.#opts.hostFingerprint) {
      config.hostVerifier = (key: Buffer): boolean => {
        const matches = hostKeyMatches(this.#opts.hostFingerprint!, key);

        if (!matches) {
          attempt.hostKeyRejected = true;
        }

        return matches;
      };
    }

    return config;
  }
}
