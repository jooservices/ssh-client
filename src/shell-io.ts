import { SshClientError } from './errors.js';
import { cleanOutput, OutputAccumulator } from './output-accumulator.js';
import { DEFAULTS, RESYNC_TIMEOUT_MS, type ResolvedOptions } from './options.js';
import { createPagerState, pagerExceededError, scanPagerText, type PagerState } from './pager.js';
import { isPromptLine, looksLikeReadyPrompt, normalizePromptRegex } from './prompt.js';

export interface ShellStream {
  write: (data: string | Buffer) => unknown;
  on(event: 'close' | 'end' | 'error', cb: (err?: unknown) => void): unknown;
  on(event: 'data', cb: (chunk: Buffer) => void): unknown;
  removeListener(event: 'close' | 'end' | 'error', cb: (err?: unknown) => void): unknown;
  removeListener(event: 'data', cb: (chunk: Buffer) => void): unknown;
}

export interface PromptWaitOptions {
  promptRegex?: RegExp | null;
  promptIdentity?: string | null;
  settleMs: number;
  timeoutMs: number;
  timeoutMessage: string;
  readyPoke?: boolean;
  maxOutputBytes: number;
}

type WaitMode = 'ready' | 'command' | 'resync';

interface Waiter {
  mode: WaitMode;
  pager: PagerState;
  maxPages: number;
  maxOutputBytes: number;
  command: string;
  timer: ReturnType<typeof setTimeout>;
  settleTimer: ReturnType<typeof setTimeout> | null;
  pokeTimer: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  idleTimeoutMs: number;
  generation: number;
  settled: boolean;
  resolve: (value: string) => void;
  reject: (reason: Error) => void;
  onAbort?: () => void;
  signal?: AbortSignal;
}

export interface ShellIoOptions {
  promptRegex?: RegExp | null;
  promptIdentity?: string | null;
  settleMs: number;
  idleBufferMaxBytes: number;
  onDead?: () => void;
}

/**
 * Persistent interactive-shell I/O: one data listener, incremental buffer,
 * pager handling, and a single settlement path per waiter.
 */
export class ShellIo {
  private readonly accumulator = new OutputAccumulator();
  private unscanned = '';
  private waiter: Waiter | null = null;
  private generation = 0;
  private detached = false;
  private promptIdentity: string | null;
  private readonly promptRegex: RegExp | null;
  private readonly settleMs: number;
  private readonly idleBufferMaxBytes: number;
  private readonly onDead?: () => void;

  constructor(
    private readonly stream: ShellStream,
    opts: ShellIoOptions,
  ) {
    this.promptRegex = opts.promptRegex ? normalizePromptRegex(opts.promptRegex) : null;
    this.promptIdentity = opts.promptIdentity ?? null;
    this.settleMs = opts.settleMs;
    this.idleBufferMaxBytes = opts.idleBufferMaxBytes;
    this.onDead = opts.onDead;
    this.stream.on('data', this.onData);
    this.stream.on('close', this.onClosed);
    this.stream.on('end', this.onClosed);
    this.stream.on('error', this.onClosed);
  }

  get capturedPrompt(): string | null {
    return this.promptIdentity;
  }

  detach(): void {
    if (this.detached) {
      return;
    }

    this.detached = true;
    this.stream.removeListener('data', this.onData);
    this.stream.removeListener('close', this.onClosed);
    this.stream.removeListener('end', this.onClosed);
    this.stream.removeListener('error', this.onClosed);
    const waiter = this.waiter;
    this.waiter = null;

    if (waiter && !waiter.settled) {
      waiter.settled = true;
      this.clearTimers(waiter);
      waiter.reject(new SshClientError('closed', 'channel closed'));
    }

    this.accumulator.clear();
    this.unscanned = '';
  }

  waitForReady(options: PromptWaitOptions): Promise<string> {
    if (options.promptIdentity) {
      this.promptIdentity = options.promptIdentity;
    }

    return this.beginWait({
      mode: 'ready',
      command: '',
      maxPages: 1,
      maxOutputBytes: options.maxOutputBytes,
      timeoutMs: options.timeoutMs,
      timeoutMessage: options.timeoutMessage,
      readyPoke: options.readyPoke === true,
      settleMs: options.settleMs,
    });
  }

  runCommand(
    command: string,
    opts: Pick<ResolvedOptions, 'commandTimeoutMs' | 'maxPages' | 'maxOutputBytes' | 'settleMs'>,
    overrides?: {
      timeoutMs?: number;
      idleTimeoutMs?: number;
      signal?: AbortSignal;
      maxPages?: number;
      maxOutputBytes?: number;
    },
  ): Promise<string> {
    const timeoutMs = overrides?.timeoutMs ?? opts.commandTimeoutMs;
    const maxPages = overrides?.maxPages ?? opts.maxPages;
    const maxOutputBytes = overrides?.maxOutputBytes ?? opts.maxOutputBytes;
    const signal = overrides?.signal;
    const idleTimeoutMs = overrides?.idleTimeoutMs ?? 0;

    if (signal?.aborted) {
      return Promise.reject(new SshClientError('closed', 'aborted'));
    }

    if (this.waiter?.mode === 'resync') {
      const resyncWaiter = this.waiter;
      this.finishWaiter(resyncWaiter, () => {
        resyncWaiter.resolve('');
      });
      this.accumulator.clear();
      this.unscanned = '';
    }

    if (this.waiter) {
      return Promise.reject(new SshClientError('invalid', 'another command is in flight'));
    }

    this.accumulator.clear();
    this.unscanned = '';

    const promise = this.beginWait({
      mode: 'command',
      command,
      maxPages,
      maxOutputBytes,
      timeoutMs,
      timeoutMessage: `command timed out after ${timeoutMs}ms`,
      settleMs: opts.settleMs,
      idleTimeoutMs,
      signal,
    });

    try {
      this.stream.write(`${command}\r`);
    } catch (error) {
      this.failWaiter(asClosedError(error), false);
    }

    return promise;
  }

  private beginWait(args: {
    mode: WaitMode;
    command: string;
    maxPages: number;
    maxOutputBytes: number;
    timeoutMs: number;
    timeoutMessage: string;
    settleMs: number;
    idleTimeoutMs?: number;
    readyPoke?: boolean;
    signal?: AbortSignal;
  }): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (this.waiter) {
        reject(new SshClientError('invalid', 'another command is in flight'));
        return;
      }

      const generation = ++this.generation;
      const onAbort = (): void => {
        this.failWaiter(new SshClientError('closed', 'aborted'), args.mode === 'command');
      };
      const waiter: Waiter = {
        mode: args.mode,
        pager: createPagerState(),
        maxPages: args.maxPages,
        maxOutputBytes: args.maxOutputBytes,
        command: args.command,
        settleTimer: null,
        pokeTimer: null,
        idleTimer: null,
        idleTimeoutMs: args.idleTimeoutMs ?? 0,
        generation,
        settled: false,
        signal: args.signal,
        onAbort,
        timer: setTimeout(() => {
          if (this.waiter !== waiter || waiter.generation !== generation) {
            return;
          }

          this.failWaiter(new SshClientError('timeout', args.timeoutMessage), args.mode === 'command');
        }, args.timeoutMs),
        resolve: (value) => {
          resolve(value);
        },
        reject: (reason) => {
          reject(reason);
        },
      };

      this.waiter = waiter;
      args.signal?.addEventListener('abort', onAbort, { once: true });
      this.armIdleTimer(waiter);

      if (args.readyPoke) {
        waiter.pokeTimer = setTimeout(() => {
          if (this.waiter !== waiter) {
            return;
          }

          try {
            this.stream.write('\r');
          } catch {
            /* poke is best-effort */
          }
        }, Math.min(500, Math.max(0, Math.floor(args.timeoutMs / 4))));
      }

      queueMicrotask(() => {
        this.evaluateWaiter();
      });
    });
  }

  private armIdleTimer(waiter: Waiter): void {
    if (waiter.idleTimer) {
      clearTimeout(waiter.idleTimer);
    }

    if (waiter.mode !== 'command' || waiter.idleTimeoutMs <= 0) {
      waiter.idleTimer = null;
      return;
    }

    waiter.idleTimer = setTimeout(() => {
      if (this.waiter !== waiter) {
        return;
      }

      this.failWaiter(
        new SshClientError('timeout', `idle timeout after ${waiter.idleTimeoutMs}ms with no output`),
        true,
      );
    }, waiter.idleTimeoutMs);
  }

  private failWaiter(err: Error, resync: boolean): void {
    const waiter = this.waiter;

    if (!waiter || waiter.settled) {
      return;
    }

    const wasPaging = waiter.pager.pages > 0 || waiter.pager.quitSent;
    const mode = waiter.mode;
    this.finishWaiter(waiter, () => {
      waiter.reject(err);
    });

    if (resync && mode === 'command') {
      this.resync(wasPaging);
    }
  }

  private finishWaiter(waiter: Waiter, settle: () => void): void {
    if (waiter.settled) {
      return;
    }

    waiter.settled = true;
    this.clearTimers(waiter);

    if (this.waiter === waiter) {
      this.waiter = null;
    }

    settle();
  }

  private clearTimers(waiter: Waiter): void {
    clearTimeout(waiter.timer);

    if (waiter.settleTimer) {
      clearTimeout(waiter.settleTimer);
    }

    if (waiter.pokeTimer) {
      clearTimeout(waiter.pokeTimer);
    }

    if (waiter.idleTimer) {
      clearTimeout(waiter.idleTimer);
    }

    if (waiter.onAbort && waiter.signal) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
    }
  }

  private readonly onData = (chunk: Buffer): void => {
    const decoded = this.accumulator.push(chunk);
    this.unscanned += decoded;

    if (!this.waiter) {
      this.accumulator.trimToMaxBytes(this.idleBufferMaxBytes);
      this.unscanned = '';
      return;
    }

    this.armIdleTimer(this.waiter);
    this.evaluateWaiter();
  };

  private evaluateWaiter(): void {
    const waiter = this.waiter;

    if (!waiter || waiter.settled) {
      return;
    }

    if (this.accumulator.byteLength > waiter.maxOutputBytes) {
      this.failWaiter(
        new SshClientError('invalid', `command output exceeded maxOutputBytes=${waiter.maxOutputBytes}`),
        false,
      );
      this.accumulator.clear();
      this.unscanned = '';
      this.die();
      return;
    }

    if (waiter.mode === 'command') {
      try {
        this.unscanned = scanPagerText(this.unscanned, this.stream, waiter.pager, waiter.maxPages);
      } catch (error) {
        this.failWaiter(asClosedError(error), false);
        this.die();
        return;
      }

      if (waiter.settled || this.waiter !== waiter) {
        return;
      }
    }

    const line = this.accumulator.currentLine();

    if (!this.lineIsPrompt(line, waiter.mode)) {
      return;
    }

    if (waiter.settleTimer) {
      clearTimeout(waiter.settleTimer);
    }

    const generation = waiter.generation;
    waiter.settleTimer = setTimeout(() => {
      if (this.waiter !== waiter || waiter.generation !== generation || waiter.settled) {
        return;
      }

      const current = this.accumulator.currentLine();

      if (!this.lineIsPrompt(current, waiter.mode)) {
        return;
      }

      if (waiter.mode === 'resync') {
        this.accumulator.clear();
        this.unscanned = '';
        this.finishWaiter(waiter, () => {
          waiter.resolve('');
        });
        return;
      }

      if (waiter.mode === 'ready') {
        this.promptIdentity = current;
        const banner = this.accumulator.snapshot();
        this.accumulator.clear();
        this.unscanned = '';
        this.finishWaiter(waiter, () => {
          waiter.resolve(banner);
        });
        return;
      }

      if (waiter.pager.quitSent && waiter.pager.pages >= waiter.maxPages) {
        this.failWaiter(pagerExceededError(waiter.maxPages), false);
        this.accumulator.clear();
        this.unscanned = '';
        return;
      }

      const raw = this.accumulator.snapshot();
      const output = cleanOutput(raw, waiter.command, current);
      this.accumulator.clear();
      this.unscanned = '';
      this.finishWaiter(waiter, () => {
        waiter.resolve(output);
      });
    }, this.settleMs);
  }

  private lineIsPrompt(line: string, mode: WaitMode): boolean {
    if (mode === 'ready' && !this.promptRegex) {
      return looksLikeReadyPrompt(line);
    }

    return isPromptLine(line, this.promptIdentity, this.promptRegex);
  }

  private resync(wasPaging: boolean): void {
    this.accumulator.clear();
    this.unscanned = '';

    try {
      this.stream.write(wasPaging ? 'q' : '\r');
    } catch {
      this.die();
      return;
    }

    void this.beginWait({
      mode: 'resync',
      command: '',
      maxPages: 1,
      maxOutputBytes: DEFAULTS.maxOutputBytes,
      timeoutMs: RESYNC_TIMEOUT_MS,
      timeoutMessage: 'resync timed out',
      settleMs: this.settleMs,
    }).catch(() => {
      this.die();
    });
  }

  private die(): void {
    if (this.detached) {
      return;
    }

    this.onDead?.();
  }

  private readonly onClosed = (err?: unknown): void => {
    if (!this.waiter || this.waiter.settled) {
      return;
    }

    this.failWaiter(new SshClientError('closed', closedMessage(err)), false);
  };
}

export function waitForPrompt(stream: ShellStream, opts: PromptWaitOptions): Promise<string> {
  const io = new ShellIo(stream, {
    promptRegex: opts.promptRegex,
    promptIdentity: opts.promptIdentity,
    settleMs: opts.settleMs,
    idleBufferMaxBytes: 64 * 1024,
  });

  return io.waitForReady(opts).finally(() => {
    io.detach();
  });
}

export function runCommandOnShell(
  stream: ShellStream,
  command: string,
  opts: ShellIoOptions &
    Pick<ResolvedOptions, 'commandTimeoutMs' | 'maxPages' | 'maxOutputBytes'>,
  overrides?: { timeoutMs?: number; signal?: AbortSignal; maxPages?: number; maxOutputBytes?: number },
): Promise<string> {
  const io = new ShellIo(stream, opts);

  return io.runCommand(command, opts, overrides).finally(() => {
    io.detach();
  });
}

export { cleanOutput } from './output-accumulator.js';

function asClosedError(error: unknown): Error {
  if (error instanceof SshClientError) {
    return error;
  }

  if (error instanceof Error) {
    return new SshClientError('closed', error.message);
  }

  return new SshClientError('closed', String(error));
}

function closedMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }

  if (typeof err === 'string' && err.trim() !== '') {
    return err;
  }

  return 'channel closed';
}
