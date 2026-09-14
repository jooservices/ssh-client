import { SshClientError } from './errors.js';
import { resolveOptions } from './options.js';
import type { ExecOptions, ExecResult, SshClientOptions } from './public-types.js';
import { createQueue } from './queue.js';
import { SshSession } from './session.js';
import { runCommandOnShell } from './shell-io.js';

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

  connect(): Promise<void> {
    return this.session.connect();
  }

  exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    const cmd = command.trim();

    if (!cmd) {
      return Promise.reject(new SshClientError('invalid', 'command is empty'));
    }

    return this.enqueue(async () => {
      if (!this.session.isOpen) {
        await this.session.connect();
      }

      const started = Date.now();
      const stdout = await runCommandOnShell(this.session.getStream(), cmd, this.opts, options);

      return { stdout, durationMs: Date.now() - started };
    });
  }

  disconnect(): Promise<void> {
    return this.session.disconnect();
  }
}
