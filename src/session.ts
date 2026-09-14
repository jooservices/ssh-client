import { Client } from 'ssh2';
import { SshClientError } from './errors.js';
import { hostKeyMatches } from './host-key.js';
import type { ResolvedOptions } from './options.js';
import { waitForPrompt } from './shell-io.js';

type ClientEvent = 'ready' | 'error';

export interface ShellChannelLike {
  close: () => void;
  on: (event: 'data', listener: (chunk: Buffer) => void) => unknown;
  removeListener: (event: 'data', listener: (chunk: Buffer) => void) => unknown;
  write: (data: string | Buffer) => unknown;
}

export interface Ssh2ClientLike {
  on: (event: ClientEvent, listener: (...args: unknown[]) => void) => Ssh2ClientLike;
  removeListener: (event: ClientEvent, listener: (...args: unknown[]) => void) => Ssh2ClientLike;
  connect: (config: Ssh2ConnectConfig) => Ssh2ClientLike;
  shell: (callback: (err: Error | undefined, stream?: ShellChannelLike) => void) => void;
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

export class SshSession {
  private client: Ssh2ClientLike | null = null;
  private stream: ShellChannelLike | null = null;
  private connecting: Promise<void> | null = null;

  constructor(
    private readonly opts: ResolvedOptions,
    private readonly clientFactory: Ssh2ClientFactory = () => new Client() as unknown as Ssh2ClientLike,
  ) {}

  get isOpen(): boolean {
    return this.client !== null && this.stream !== null;
  }

  async connect(): Promise<void> {
    if (this.isOpen) {
      return;
    }

    if (this.connecting) {
      return this.connecting;
    }

    const client = this.clientFactory();

    this.connecting = new Promise<void>((resolve, reject) => {
      let settled = false;

      const cleanup = (): void => {
        client.removeListener('ready', onReady);
        client.removeListener('error', onError);
      };

      const fail = (code: 'connect' | 'auth' | 'timeout', message: string): void => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();
        client.end();
        this.client = null;
        this.stream = null;
        reject(new SshClientError(code, message));
      };

      const onReady = (): void => {
        client.shell((err, stream) => {
          if (err || !stream) {
            fail('connect', err?.message ?? 'shell failed');
            return;
          }

          cleanup();
          this.client = client;
          this.stream = stream;

          waitForPrompt(stream, {
            promptRegex: this.opts.promptRegex,
            settleMs: this.opts.settleMs,
            timeoutMs: this.opts.readyTimeoutMs,
            timeoutMessage: `ready prompt timed out after ${this.opts.readyTimeoutMs}ms`,
          })
            .then(() => {
              if (settled) {
                return;
              }

              settled = true;
              resolve();
            })
            .catch((error: unknown) => {
              if (error instanceof SshClientError && error.code === 'timeout') {
                fail('timeout', error.message);
                return;
              }

              fail('connect', errorMessage(error));
            });
        });
      };

      const onError = (err: unknown): void => {
        const message = errorMessage(err);
        fail(isAuthenticationError(message) ? 'auth' : 'connect', message);
      };

      client.on('ready', onReady).on('error', onError).connect(this.connectConfig());
    });

    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  getStream(): ShellChannelLike {
    if (!this.stream) {
      throw new SshClientError('closed', 'not connected');
    }

    return this.stream;
  }

  async disconnect(): Promise<void> {
    this.stream?.close();
    this.client?.end();
    this.stream = null;
    this.client = null;
    this.connecting = null;
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

function isAuthenticationError(message: string): boolean {
  return /auth|password|credential/i.test(message);
}
