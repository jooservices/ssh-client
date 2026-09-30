import { SshClientError } from './errors.js';
import { resolveExecOptions, resolveOptions, validateCommand, type ResolvedExecOptions } from './options.js';
import type { ExecOptions, ExecResult, SshClientOptions } from './public-types.js';
import { createQueue } from './queue.js';
import { SshSession } from './session.js';

export class SshClient {
  readonly #opts;
  readonly #session: SshSession;
  readonly #enqueue = createQueue();
  #accepting = true;
  #epoch = 0;

  constructor(options: SshClientOptions) {
    this.#opts = resolveOptions(options);
    this.#session = new SshSession(this.#opts);
  }

  get connected(): boolean {
    return this.#session.isOpen;
  }

  /** PTY window used for the last shell that reached a prompt. */
  get shellWindow() {
    return this.#session.shellWindow;
  }

  connect(): Promise<void> {
    if (!this.#accepting) {
      return Promise.reject(new SshClientError('closed', 'disconnected'));
    }

    const epoch = this.#epoch;

    return this.#session.connect().then(() => {
      if (epoch !== this.#epoch) {
        throw new SshClientError('closed', 'disconnected');
      }
    });
  }

  exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    let cmd: string;
    let limits: ResolvedExecOptions;

    try {
      cmd = validateCommand(command);
      limits = resolveExecOptions(this.#opts, options);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new SshClientError('invalid', String(error)));
    }

    if (!this.#accepting) {
      return Promise.reject(new SshClientError('closed', 'disconnected'));
    }

    const signal = options?.signal;

    if (signal?.aborted) {
      return Promise.reject(new SshClientError('closed', 'aborted'));
    }

    const epoch = this.#epoch;

    return new Promise<ExecResult>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown, value?: ExecResult): void => {
        if (settled) {
          return;
        }

        settled = true;
        signal?.removeEventListener('abort', onAbort);

        if (error) {
          reject(error instanceof Error ? error : new SshClientError('closed', String(error)));
          return;
        }

        resolve(value as ExecResult);
      };
      const onAbort = (): void => {
        finish(new SshClientError('closed', 'aborted'));
      };

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      void this.#enqueue(async () => {
        if (signal?.aborted || settled) {
          throw new SshClientError('closed', 'aborted');
        }

        if (!this.#accepting || epoch !== this.#epoch) {
          throw new SshClientError('closed', 'disconnected');
        }

        const connectStarted = performance.now();
        let connectMs = 0;

        if (!this.#session.isOpen) {
          await this.#session.connect(signal);
          connectMs = performance.now() - connectStarted;
        }

        if (signal?.aborted || settled) {
          throw new SshClientError('closed', 'aborted');
        }

        if (!this.#accepting || epoch !== this.#epoch) {
          throw new SshClientError('closed', 'disconnected');
        }

        const sendAt = Date.now();
        const runStarted = performance.now();
        const stdout = await this.#session.getIo().runCommand(cmd, this.#opts, {
          ...limits,
          signal,
        });

        return {
          stdout,
          durationMs: performance.now() - runStarted,
          sendAt,
          recvAt: Date.now(),
          connectMs,
        };
      }).then(
        (value) => {
          finish(undefined, value);
        },
        (error: unknown) => {
          finish(error);
        },
      );
    });
  }

  /**
   * Tear the session down. Exec calls that started before this barrier reject
   * with `closed`. A later `connect()` / `exec()` may open a new session.
   */
  disconnect(): Promise<void> {
    this.#accepting = false;
    const epoch = ++this.#epoch;

    return this.#session.disconnect().finally(() => {
      if (this.#epoch === epoch) {
        this.#accepting = true;
      }
    });
  }
}
