import { EventEmitter } from 'node:events';
import type { ShellChannelLike, Ssh2ClientLike, Ssh2ConnectConfig } from '../../src/session.js';

export interface FakeSsh2ClientOptions {
  hostKey?: Buffer;
  authFailure?: boolean;
  connectError?: Error;
  shellError?: Error;
  channel?: FakeSsh2Channel;
  banner?: string;
  initialPrompt?: string;
  commands?: Record<string, FakeCommandScript>;
}

export interface FakeCommandScript {
  chunks?: string[];
  body?: string;
  prompt?: string;
  echo?: boolean;
  delayMs?: number;
}

export interface FakeSsh2ChannelOptions {
  commands?: Record<string, FakeCommandScript>;
  prompt?: string;
}

export class FakeSsh2Channel extends EventEmitter implements ShellChannelLike {
  readonly writes: Array<string | Buffer> = [];
  readonly commands: string[] = [];
  closed = false;

  constructor(private readonly options: FakeSsh2ChannelOptions = {}) {
    super();
  }

  write(data: string | Buffer): boolean {
    this.writes.push(data);

    const text = Buffer.isBuffer(data) ? data.toString('utf8') : data;

    if (text.endsWith('\r')) {
      const command = text.trim();
      this.commands.push(command);
      this.emitCommand(command);
    }

    return true;
  }

  close(): void {
    this.closed = true;
  }

  emitText(text: string): void {
    this.emit('data', Buffer.from(text));
  }

  private emitCommand(command: string): void {
    const script = this.options.commands?.[command];

    if (!script) {
      return;
    }

    const prompt = script.prompt ?? this.options.prompt ?? 'router# ';
    const chunks = script.chunks ?? [script.body ?? ''];
    const delayMs = script.delayMs ?? 0;
    const emit = (): void => {
      if (script.echo !== false) {
        this.emitText(`${command}\r\n`);
      }

      for (const chunk of chunks) {
        this.emitText(chunk);
      }

      this.emitText(prompt);
    };

    if (delayMs > 0) {
      setTimeout(emit, delayMs);
      return;
    }

    queueMicrotask(emit);
  }
}

export class FakeSsh2Client extends EventEmitter implements Ssh2ClientLike {
  readonly hostVerifierKeys: Buffer[] = [];
  readonly channel: FakeSsh2Channel;
  connectConfig: Ssh2ConnectConfig | null = null;
  ended = false;

  constructor(private readonly options: FakeSsh2ClientOptions = {}) {
    super();
    this.channel = options.channel ?? new FakeSsh2Channel({ commands: options.commands, prompt: options.initialPrompt });
  }

  override on(event: 'ready' | 'error', listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }

  override removeListener(event: 'ready' | 'error', listener: (...args: unknown[]) => void): this {
    return super.removeListener(event, listener);
  }

  connect(config: Ssh2ConnectConfig): this {
    this.connectConfig = config;

    queueMicrotask(() => {
      const hostKey = this.options.hostKey ?? Buffer.from('fake-host-key');

      if (config.hostVerifier) {
        this.hostVerifierKeys.push(hostKey);

        if (!config.hostVerifier(hostKey)) {
          this.emit('error', new Error('Host key verification failed'));
          return;
        }
      }

      if (this.options.authFailure) {
        this.emit('error', new Error('All configured authentication methods failed'));
        return;
      }

      if (this.options.connectError) {
        this.emit('error', this.options.connectError);
        return;
      }

      this.emit('ready');
    });

    return this;
  }

  shell(callback: (err: Error | undefined, stream?: ShellChannelLike) => void): void {
    queueMicrotask(() => {
      callback(this.options.shellError, this.options.shellError ? undefined : this.channel);

      if (!this.options.shellError) {
        this.channel.emitText(`${this.options.banner ?? ''}${this.options.initialPrompt ?? 'router# '}`);
      }
    });
  }

  end(): void {
    this.ended = true;
  }
}
