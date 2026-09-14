import { EventEmitter } from 'node:events';
import type { ShellChannelLike, Ssh2ClientLike, Ssh2ConnectConfig } from '../../src/session.js';

export interface FakeSsh2ClientOptions {
  hostKey?: Buffer;
  authFailure?: boolean;
  connectError?: Error;
  shellError?: Error;
  shellDelayMs?: number;
  channel?: FakeSsh2Channel;
  banner?: string;
  initialPrompt?: string;
  initialPromptDelayMs?: number;
  promptOnPoke?: boolean;
  commands?: Record<string, FakeCommandScript>;
}

export interface FakeCommandScript {
  chunks?: string[];
  body?: string;
  prompt?: string;
  echo?: boolean;
  delayMs?: number;
  channelEvent?: 'close' | 'end' | 'error';
  channelError?: Error;
  clientClose?: boolean;
}

export interface FakeSsh2ChannelOptions {
  commands?: Record<string, FakeCommandScript>;
  prompt?: string;
  onClientClose?: () => void;
}

export class FakeSsh2Channel extends EventEmitter implements ShellChannelLike {
  readonly writes: Array<string | Buffer> = [];
  readonly commands: string[] = [];
  closed = false;
  private pendingChunks: string[] | null = null;
  private pendingPrompt: string | null = null;
  private pendingEcho: string | null = null;

  constructor(private readonly options: FakeSsh2ChannelOptions = {}) {
    super();
  }

  write(data: string | Buffer): boolean {
    this.writes.push(data);

    const text = Buffer.isBuffer(data) ? data.toString('utf8') : data;

    if (text === ' ' && this.pendingChunks && this.pendingChunks.length > 0) {
      this.emitText(this.pendingChunks.shift()!);
      if (this.pendingChunks.length === 0) {
        this.finishPendingCommand();
      }
      return true;
    }

    if (text === 'q' && this.pendingChunks) {
      this.pendingChunks = [];
      this.finishPendingCommand();
      return true;
    }

    if (text === '\r' && this.options.prompt) {
      this.emitText(this.options.prompt);
      return true;
    }

    if (text.endsWith('\r')) {
      const command = text.trim();
      this.commands.push(command);
      this.emitCommand(command);
    }

    return true;
  }

  close(): void {
    this.closed = true;
    this.emit('close');
  }

  emitText(text: string): void {
    this.emit('data', Buffer.from(text));
  }

  emitEnd(): void {
    this.emit('end');
  }

  emitChannelError(error: Error = new Error('channel error')): void {
    this.emit('error', error);
  }

  private finishPendingCommand(): void {
    if (this.pendingEcho) {
      // already echoed at start
      this.pendingEcho = null;
    }
    const prompt = this.pendingPrompt ?? this.options.prompt ?? 'router# ';
    this.pendingChunks = null;
    this.pendingPrompt = null;
    this.emitText(prompt);
  }

  private emitCommand(command: string): void {
    const script = this.options.commands?.[command];

    if (!script) {
      return;
    }

    const prompt = script.prompt ?? this.options.prompt ?? 'router# ';
    const chunks = [...(script.chunks ?? [script.body ?? ''])];
    const delayMs = script.delayMs ?? 0;
    const emit = (): void => {
      if (script.echo !== false) {
        this.emitText(`${command}\r\n`);
      }

      if (script.channelEvent) {
        for (const chunk of chunks) {
          this.emitText(chunk);
        }
        this.emitScriptChannelEvent(script);
        return;
      }

      if (script.clientClose) {
        for (const chunk of chunks) {
          this.emitText(chunk);
        }
        this.options.onClientClose?.();
        return;
      }

      const first = chunks.shift() ?? '';
      const hasMorePages = chunks.length > 0 && /---\s*MORE\s*---/i.test(first);
      if (hasMorePages) {
        this.pendingChunks = chunks;
        this.pendingPrompt = prompt;
      }

      this.emitText(first);

      if (hasMorePages) {
        return;
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

  private emitScriptChannelEvent(script: FakeCommandScript): void {
    if (script.channelEvent === 'close') {
      this.close();
      return;
    }

    if (script.channelEvent === 'end') {
      this.emitEnd();
      return;
    }

    this.emitChannelError(script.channelError);
  }
}

export class FakeSsh2Client extends EventEmitter implements Ssh2ClientLike {
  readonly hostVerifierKeys: Buffer[] = [];
  readonly channel: FakeSsh2Channel;
  connectConfig: Ssh2ConnectConfig | null = null;
  shellOptions: { term: string; rows: number; cols: number } | null = null;
  ended = false;

  constructor(private readonly options: FakeSsh2ClientOptions = {}) {
    super();
    this.channel =
      options.channel ??
      new FakeSsh2Channel({
        commands: options.commands,
        onClientClose: () => this.emitClose(),
        prompt: options.initialPrompt,
      });
  }

  override on(event: 'ready' | 'error' | 'close', listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }

  override removeListener(event: 'ready' | 'error' | 'close', listener: (...args: unknown[]) => void): this {
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

  shell(
    options: { term: string; rows: number; cols: number },
    callback: (err: Error | undefined, stream?: ShellChannelLike) => void,
  ): void {
    this.shellOptions = options;
    const run = (): void => {
      callback(this.options.shellError, this.options.shellError ? undefined : this.channel);

      if (!this.options.shellError) {
        const emitPrompt = (): void => {
          this.channel.emitText(`${this.options.banner ?? ''}${this.options.initialPrompt ?? 'router# '}`);
        };

        if (this.options.initialPromptDelayMs) {
          setTimeout(emitPrompt, this.options.initialPromptDelayMs);
        } else if (!this.options.promptOnPoke) {
          emitPrompt();
        }
      }
    };

    if (this.options.shellDelayMs && this.options.shellDelayMs > 0) {
      setTimeout(run, this.options.shellDelayMs);
      return;
    }

    queueMicrotask(run);
  }

  end(): void {
    this.ended = true;
    this.emitClose();
  }

  emitClose(): void {
    this.emit('close');
  }
}
