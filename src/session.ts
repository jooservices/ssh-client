import { Client } from 'ssh2';
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
    if (attempt.tornDown || this.inflight?.attempt !== attempt || this.inflight.settled) {
      return;
    }

    if (this.remaining(attempt) === 0) {
      this.failInflight(attempt, 'timeout', this.readyTimeoutMessage());
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

    if (attempt.tornDown || this.inflight?.attempt !== attempt || this.inflight.settled) {
      if (stream) {
        try {
          stream.close();
        } catch {
          /* stale shell */
        }
      }
      return;
    }

    if (err || !stream) {
      if (stream) {
        try {
          stream.close();
        } catch {
          /* ignore */
        }
      }
      this.failInflight(attempt, 'connect', err?.message ?? 'shell failed');
      return;
    }

    const left = this.remaining(attempt);

    if (left === 0) {
      try {
        stream.close();
      } catch {
        /* ignore */
      }
      this.failInflight(attempt, 'timeout', this.readyTimeoutMessage());
      return;
    }

    attempt.stream = stream;
    const inflight = this.inflight;
    attempt.io = new ShellIo(stream, {
      promptRegex: this.opts.promptRegex,
      settleMs: this.opts.settleMs,
      idleBufferMaxBytes: this.opts.idleBufferMaxBytes,
      onDead: () => {
        if (attempt.tornDown) {
          return;
        }

        if (this.active === attempt) {
          this.teardown(attempt);
        }
      },
    });

    const onChannelGone: ChannelListener = (): void => {
      if (attempt.tornDown) {
        return;
      }

      if (this.inflight?.attempt === attempt && !this.inflight.settled) {
        this.failInflight(attempt, 'connect', 'channel closed');
        return;
      }

      if (this.active === attempt) {
        this.teardown(attempt);
      }
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
        if (attempt.tornDown || inflight.settled || this.inflight?.attempt !== attempt) {
          return;
        }

        if (error instanceof SshClientError && (error.code === 'timeout' || error.code === 'invalid')) {
          this.failInflight(attempt, error.code, error.message);
          return;
        }

        this.failInflight(attempt, 'connect', errorMessage(error));
      });
  }

  private onClientError(attempt: ConnectionAttempt, err: unknown): void {
    if (attempt.tornDown) {
      return;
    }

    if (this.inflight?.attempt === attempt && !this.inflight.settled) {
      const message = errorMessage(err);
      this.failInflight(attempt, classifyConnectError(message), message);
      return;
    }

    if (this.active === attempt) {
      this.teardown(attempt);
    }
  }

  private onClientClose(attempt: ConnectionAttempt): void {
    if (attempt.tornDown) {
      return;
    }

    if (this.inflight?.attempt === attempt && !this.inflight.settled) {
      this.failInflight(attempt, 'connect', 'channel closed');
      return;
    }

    if (this.active === attempt) {
      this.teardown(attempt);
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
    attempt.client.removeListener('error', swallow);
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

function classifyConnectError(message: string): 'connect' | 'auth' | 'timeout' {
  if (/timed out/i.test(message)) {
    return 'timeout';
  }

  if (/auth|password|credential/i.test(message)) {
    return 'auth';
  }

  return 'connect';
}
