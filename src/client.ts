import { SshClientError } from './errors.js';
import { resolveOptions } from './options.js';
import type { ExecOptions, ExecResult, SshClientOptions } from './public-types.js';
import { createQueue } from './queue.js';
import { SshSession } from './session.js';

export class SshClient {
  private readonly opts;
  private readonly session: SshSession;
  private readonly enqueue = createQueue();

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
    return this.session.connect();
  }

  exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    const cmd = command.trim();

    if (!cmd) {
      return Promise.reject(new SshClientError('invalid', 'command is empty'));
    }

    return this.enqueue(async () => {
      const connectStarted = Date.now();
      let connectMs = 0;

      if (!this.session.isOpen) {
        await this.session.connect();
        connectMs = Date.now() - connectStarted;
      }

      const sendAt = Date.now();
      try {
        const stdout = await this.session.getIo().runCommand(cmd, this.opts, options);
        const recvAt = Date.now();
        return {
          stdout,
          durationMs: recvAt - sendAt,
          sendAt,
          recvAt,
          connectMs,
        };
      } catch (err) {
        const recvAt = Date.now();
        if (err instanceof SshClientError) {
          // Attach timing on the error path for callers that inspect duration via result only — rethrow
          void recvAt;
          throw err;
        }
        throw err;
      }
    });
  }

  /**
   * Best-effort `exit` then tear down the session. A later `connect()` / `exec()`
   * may open a new session (disconnect is not permanent).
   */
  disconnect(): Promise<void> {
    return this.session.disconnect();
  }
}
