import { messageOf, SshClientError, toSshError } from './errors.js';
import { cleanOutput, OutputAccumulator } from './output-accumulator.js';
import {
  DEFAULTS,
  INTERRUPT,
  KILL_LINE,
  RESYNC_TIMEOUT_MS,
  type ResolvedOptions,
} from './options.js';
import { createPagerState, handlePagerTail, markerOnTail, pagerExceededError, type PagerState } from './pager.js';
import { compilePromptRegex, isPromptLine, looksLikeReadyPrompt } from './prompt.js';

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
  confirming: boolean;
  candidate: string;
  killSent: boolean;
  resolve: (value: string) => void;
  reject: (reason: Error) => void;
  onAbort?: () => void;
  signal?: AbortSignal;
}

export interface ShellIoOptions {
  promptRegex?: RegExp | null;
  promptIdentity?: string | null;
  settleMs: number;
  /** Accepted and ignored. Idle bytes are discarded on arrival. */
  idleBufferMaxBytes: number;
  maxPromptLength?: number;
  maxOutputBytes?: number;
  onDead?: () => void;
}

/**
 * Persistent interactive-shell I/O: one data listener, incremental buffer,
 * pager handling, and a single settlement path per waiter.
 */
export class ShellIo {
  private readonly accumulator: OutputAccumulator;
  private waiter: Waiter | null = null;
  private generation = 0;
  private detached = false;
  private deadNotified = false;
  private resyncFailed = false;
  private resyncing: Promise<void> | null = null;
  private promptIdentity: string | null;
  private lastPrompt: string;
  private outputCap: number;
  private readonly promptRegex: RegExp | null;
  private readonly settleMs: number;
  private readonly onDead?: () => void;
  private readonly stream: ShellStream;

  constructor(stream: ShellStream, opts: ShellIoOptions) {
    void opts.idleBufferMaxBytes;
    this.stream = stream;
    this.promptRegex = opts.promptRegex ? compilePromptRegex(opts.promptRegex) : null;
    this.promptIdentity = opts.promptIdentity ?? null;
    this.lastPrompt = opts.promptIdentity ?? '';
    this.settleMs = opts.settleMs;
    this.outputCap = opts.maxOutputBytes ?? DEFAULTS.maxOutputBytes;
    this.onDead = opts.onDead;
    this.accumulator = new OutputAccumulator(opts.maxPromptLength ?? DEFAULTS.maxPromptLength);
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
  }

  waitForReady(options: PromptWaitOptions): Promise<string> {
    if (options.promptIdentity) {
      this.promptIdentity = options.promptIdentity;
      this.lastPrompt = options.promptIdentity;
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

  async runCommand(
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
    const signal = overrides?.signal;

    if (signal?.aborted) {
      throw new SshClientError('closed', 'aborted');
    }

    if (this.resyncFailed || this.detached) {
      throw new SshClientError('closed', 'resync failed');
    }

    if (this.resyncing) {
      try {
        await this.resyncing;
      } catch {
        throw new SshClientError('closed', 'resync failed');
      }
    }

    if (this.resyncFailed || this.detached) {
      throw new SshClientError('closed', 'resync failed');
    }

    if (this.waiter) {
      throw new SshClientError('invalid', 'another command is in flight');
    }

    const timeoutMs = overrides?.timeoutMs ?? opts.commandTimeoutMs;
    const maxPages = overrides?.maxPages ?? opts.maxPages;
    const maxOutputBytes = overrides?.maxOutputBytes ?? opts.maxOutputBytes;
    this.outputCap = maxOutputBytes;
    this.accumulator.clear();

    const promise = this.beginWait({
      mode: 'command',
      command,
      maxPages,
      maxOutputBytes,
      timeoutMs,
      timeoutMessage: `command timed out after ${timeoutMs}ms`,
      settleMs: opts.settleMs,
      idleTimeoutMs: overrides?.idleTimeoutMs ?? 0,
      signal,
    });

    try {
      this.stream.write(`${command}\r`);
    } catch (error) {
      this.failWaiter(toSshError(error, 'closed'), false);
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
        confirming: false,
        candidate: '',
        killSent: false,
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
          if (this.waiter !== waiter || waiter.confirming) {
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
    if (!this.waiter) {
      this.accumulator.drop(chunk);
      return;
    }

    this.accumulator.push(chunk);
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
        new SshClientError('limit', `command output exceeded maxOutputBytes=${waiter.maxOutputBytes}`),
        false,
      );
      this.accumulator.clear();
      this.die();
      return;
    }

    if (waiter.mode === 'command' && this.pageTail(waiter)) {
      return;
    }

    const line = this.accumulator.currentLine();
    const prompt = !this.accumulator.lineTooLong() && this.lineIsPrompt(line, waiter.mode);
    const dirty = waiter.mode === 'resync' && line.length > 0 && !prompt && !waiter.killSent;

    if (!prompt && !dirty) {
      if (waiter.settleTimer) {
        clearTimeout(waiter.settleTimer);
        waiter.settleTimer = null;
      }

      return;
    }

    if (waiter.settleTimer) {
      clearTimeout(waiter.settleTimer);
    }

    const generation = waiter.generation;
    waiter.settleTimer = setTimeout(() => {
      this.onSettled(waiter, generation);
    }, this.settleMs);
  }

  private pageTail(waiter: Waiter): boolean {
    const before = this.accumulator.pagerTail();

    if (waiter.pager.answeredEpoch !== this.accumulator.lineEpoch) {
      waiter.pager.answeredTail = null;
      waiter.pager.answeredEpoch = this.accumulator.lineEpoch;
    }

    try {
      const acted = handlePagerTail(before, this.stream, waiter.pager, waiter.maxPages);

      if (!acted || this.waiter !== waiter) {
        return acted;
      }

      // A synchronous pager reply may already have armed the next settle.
      if (this.accumulator.pagerTail() === before && waiter.settleTimer) {
        clearTimeout(waiter.settleTimer);
        waiter.settleTimer = null;
      }

      return this.accumulator.pagerTail() === before;
    } catch (error) {
      this.failWaiter(toSshError(error, 'closed'), false);
      this.die();
      return true;
    }
  }

  private onSettled(waiter: Waiter, generation: number): void {
    if (this.waiter !== waiter || waiter.generation !== generation || waiter.settled) {
      return;
    }

    const current = this.accumulator.currentLine();
    const prompt = !this.accumulator.lineTooLong() && this.lineIsPrompt(current, waiter.mode);

    if (waiter.mode === 'resync') {
      this.settleResync(waiter, current, prompt);
      return;
    }

    if (!prompt) {
      return;
    }

    if (waiter.mode === 'ready') {
      this.settleReady(waiter, current);
      return;
    }

    if (waiter.pager.quitSent && waiter.pager.pages >= waiter.maxPages) {
      this.failWaiter(pagerExceededError(waiter.maxPages), false);
      this.accumulator.clear();
      return;
    }

    const previous = this.lastPrompt;
    const raw = this.accumulator.snapshot();
    const output = cleanOutput(raw, waiter.command, current, previous, waiter.pager.handled);
    this.lastPrompt = current;
    this.promptIdentity = this.promptRegex ? current : this.promptIdentity;
    this.accumulator.clear();
    this.finishWaiter(waiter, () => {
      waiter.resolve(output);
    });
  }

  private settleReady(waiter: Waiter, current: string): void {
    if (!waiter.confirming || waiter.candidate !== current) {
      waiter.confirming = true;
      waiter.candidate = current;
      this.accumulator.clear();

      if (waiter.pokeTimer) {
        clearTimeout(waiter.pokeTimer);
        waiter.pokeTimer = null;
      }

      // Set confirming before write: a synchronous echo re-enters onData.
      try {
        this.stream.write('\r');
      } catch {
        /* confirmation is best-effort */
      }

      return;
    }

    this.promptIdentity = current;
    this.lastPrompt = current;
    const banner = this.accumulator.snapshot();
    this.accumulator.clear();
    this.finishWaiter(waiter, () => {
      waiter.resolve(banner);
    });
  }

  private settleResync(waiter: Waiter, current: string, prompt: boolean): void {
    if (!prompt) {
      if (!waiter.killSent && current.length > 0) {
        waiter.killSent = true;
        this.accumulator.clear();

        try {
          this.stream.write(`${KILL_LINE}\r`);
        } catch {
          /* the following wait still has the deadline */
        }
      }

      return;
    }

    this.lastPrompt = current;
    this.accumulator.clear();
    this.finishWaiter(waiter, () => {
      waiter.resolve('');
    });
  }

  private lineIsPrompt(line: string, mode: WaitMode): boolean {
    if (mode === 'ready' && !this.promptRegex) {
      return looksLikeReadyPrompt(line);
    }

    return isPromptLine(line, this.promptIdentity, this.promptRegex);
  }

  private resync(wasPaging: boolean): void {
    if (this.resyncing || this.detached || this.resyncFailed) {
      return;
    }

    let run: Promise<void> = Promise.resolve();
    run = this.performResync(wasPaging).finally(() => {
      if (this.resyncing === run) {
        this.resyncing = null;
      }
    });
    this.resyncing = run;
    void run.catch(() => undefined);
  }

  private async performResync(pagerUp: boolean): Promise<void> {
    const deadline = performance.now() + RESYNC_TIMEOUT_MS;
    const quitPager = pagerUp && markerOnTail(this.accumulator.pagerTail());
    this.accumulator.clear();

    try {
      await this.resyncStep(quitPager ? 'q' : INTERRUPT, deadline);
    } catch (error) {
      if (!quitPager || this.detached || deadline - performance.now() <= 0) {
        this.markResyncFailed();
        throw error;
      }

      try {
        await this.resyncStep(INTERRUPT, deadline);
      } catch (second) {
        this.markResyncFailed();
        throw second;
      }
    }
  }

  private async resyncStep(key: string, deadline: number): Promise<void> {
    const pending = this.waitResync(deadline);

    try {
      this.stream.write(key);
    } catch (error) {
      this.failWaiter(toSshError(error, 'closed'), false);
      await pending.catch(() => undefined);
      throw toSshError(error, 'closed');
    }

    await pending;
  }

  private waitResync(deadline: number): Promise<string> {
    const timeoutMs = Math.max(1, Math.ceil(deadline - performance.now()));

    return this.beginWait({
      mode: 'resync',
      command: '',
      maxPages: 1,
      maxOutputBytes: this.outputCap,
      timeoutMs,
      timeoutMessage: 'resync timed out',
      settleMs: this.settleMs,
    });
  }

  private markResyncFailed(): void {
    if (this.detached) {
      return;
    }

    this.resyncFailed = true;
    this.die();
  }

  private die(): void {
    if (this.detached || this.deadNotified) {
      return;
    }

    this.deadNotified = true;
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
  opts: ShellIoOptions & Pick<ResolvedOptions, 'commandTimeoutMs' | 'maxPages' | 'maxOutputBytes'>,
  overrides?: { timeoutMs?: number; signal?: AbortSignal; maxPages?: number; maxOutputBytes?: number },
): Promise<string> {
  const io = new ShellIo(stream, opts);

  return io.runCommand(command, opts, overrides).finally(() => {
    io.detach();
  });
}

export { cleanOutput } from './output-accumulator.js';

function closedMessage(err: unknown): string {
  if (typeof err === 'string' && err.trim() !== '') {
    return err;
  }

  if (err instanceof Error && err.message.trim() !== '') {
    return err.message;
  }

  if (err === undefined) {
    return 'channel closed';
  }

  const message = messageOf(err);

  return message.trim() === '' ? 'channel closed' : message;
}
