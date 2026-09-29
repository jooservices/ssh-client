import { SshClientError } from './errors.js';
import { resolveExecOptions, resolveOptions } from './options.js';
import type { ExecOptions, ExecResult, SshClientOptions } from './public-types.js';
import { createQueue } from './queue.js';
import { SshSession } from './session.js';

export class SshClient {
  private readonly opts;
  private readonly session: SshSession;
  private readonly enqueue = createQueue();
  private accepting = true;
  private epoch = 0;

  constructor(options: SshClientOptions) {
    this.opts = resolveOptions(options);
    this.session = new SshSession(this.opts);
  }

  get connected(): boolean {
    return this.session.isOpen;
  }

  /** PTY window used for the current/last shell (null before first connect). */
  get shellWindow() {
    return this.session.shellWindow;
  }

  connect(): Promise<void> {
    if (!this.accepting) {
      return Promise.reject(new SshClientError('closed', 'disconnected'));
    }

    const epoch = this.epoch;

    return this.session.connect().then(() => {
      if (epoch !== this.epoch) {
        throw new SshClientError('closed', 'disconnected');
      }
    });
  }

  exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    const cmd = command.trim();

    if (!cmd) {
      return Promise.reject(new SshClientError('invalid', 'command is empty'));
    }

    let limits;

    try {
      limits = resolveExecOptions(this.opts, options);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new SshClientError('invalid', String(error)));
    }

    if (!this.accepting) {
      return Promise.reject(new SshClientError('closed', 'disconnected'));
    }

    if (options?.signal?.aborted) {
      return Promise.reject(new SshClientError('closed', 'aborted'));
    }

    const epoch = this.epoch;
    const signal = options?.signal;

    return this.enqueue(async () => {
      if (!this.accepting || epoch !== this.epoch) {
        throw new SshClientError('closed', 'disconnected');
      }

      if (signal?.aborted) {
        throw new SshClientError('closed', 'aborted');
      }

      const connectStarted = Date.now();
      let connectMs = 0;

      if (!this.session.isOpen) {
        await this.session.connect(signal);
        connectMs = Date.now() - connectStarted;
      }

      if (!this.accepting || epoch !== this.epoch) {
        throw new SshClientError('closed', 'disconnected');
      }

      const sendAt = Date.now();
      const stdout = await this.session.getIo().runCommand(cmd, this.opts, {
        ...limits,
        signal,
      });
      const recvAt = Date.now();

      return {
        stdout,
        durationMs: recvAt - sendAt,
        sendAt,
        recvAt,
        connectMs,
      };
    });
  }

  /**
   * Best-effort `exit` then tear down the session.
   * Exec calls that started before this barrier reject with `closed`.
   * A later `connect()` / `exec()` may open a new session.
   */
  disconnect(): Promise<void> {
    this.accepting = false;
    const epoch = ++this.epoch;

    return this.session.disconnect().finally(() => {
      if (this.epoch === epoch) {
        this.accepting = true;
      }
    });
  }
}
