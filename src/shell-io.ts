import { SshClientError } from './errors.js';
import type { ResolvedOptions } from './options.js';
import { createPagerState, handlePagerIfNeeded, type PagerState } from './pager.js';

export interface ShellStream {
  write: (data: string | Buffer) => unknown;
  on(event: 'close' | 'end' | 'error', cb: (err?: unknown) => void): unknown;
  on(event: 'data', cb: (chunk: Buffer) => void): unknown;
  removeListener(event: 'close' | 'end' | 'error', cb: (err?: unknown) => void): unknown;
  removeListener(event: 'data', cb: (chunk: Buffer) => void): unknown;
}

export interface PromptWaitOptions {
  promptRegex: RegExp;
  settleMs: number;
  timeoutMs: number;
  timeoutMessage: string;
  readyPoke?: boolean;
}

type WaitMode = 'ready' | 'command' | 'resync';

interface Waiter {
  mode: WaitMode;
  start: number;
  pager: PagerState;
  maxPages: number;
  maxOutputBytes: number;
  command: string;
  timer: ReturnType<typeof setTimeout>;
  settleTimer: ReturnType<typeof setTimeout> | null;
  pokeTimer: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  idleTimeoutMs: number;
  resolve: (value: string) => void;
  reject: (reason: Error) => void;
  onAbort?: () => void;
  signal?: AbortSignal;
}

/**
 * Persistent interactive-shell I/O: one data listener, idle buffer trim,
 * pager handling, timeout resync.
 */
export class ShellIo {
  private parts: string[] = [];
  private partsBytes = 0;
  private waiter: Waiter | null = null;
  private generation = 0;
  private readonly promptRegex: RegExp;
  private readonly settleMs: number;
  private readonly idleBufferMaxBytes: number;

  constructor(
    private readonly stream: ShellStream,
    opts: Pick<ResolvedOptions, 'promptRegex' | 'settleMs' | 'idleBufferMaxBytes'>,
  ) {
    this.promptRegex = normalizePromptRegex(opts.promptRegex);
    this.settleMs = opts.settleMs;
    this.idleBufferMaxBytes = opts.idleBufferMaxBytes;
    this.stream.on('data', this.onData);
    this.stream.on('close', this.onClosed);
    this.stream.on('end', this.onClosed);
    this.stream.on('error', this.onClosed);
  }

  private get buf(): string {
    return this.parts.join('');
  }

  private setBuf(value: string): void {
    this.parts = value.length > 0 ? [value] : [];
    this.partsBytes = Buffer.byteLength(value, 'utf8');
  }

  private appendBuf(chunk: string): void {
    this.parts.push(chunk);
    this.partsBytes += Buffer.byteLength(chunk, 'utf8');
  }

  private clearBuf(): void {
    this.parts = [];
    this.partsBytes = 0;
  }

  detach(): void {
    this.stream.removeListener('data', this.onData);
    this.stream.removeListener('close', this.onClosed);
    this.stream.removeListener('end', this.onClosed);
    this.stream.removeListener('error', this.onClosed);
    const w = this.waiter;
    this.clearWaiter();
    if (w) {
      w.reject(new SshClientError('closed', 'channel closed'));
    }
    this.clearBuf();
  }

  waitForReady(options: PromptWaitOptions): Promise<string> {
    return this.beginWait({
      mode: 'ready',
      command: '',
      maxPages: 1,
      maxOutputBytes: Number.MAX_SAFE_INTEGER,
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

    // Drop best-effort resync waiters so the next command can proceed.
    if (this.waiter?.mode === 'resync') {
      this.clearWaiter();
      this.clearBuf();
    }

    if (this.waiter) {
      return Promise.reject(new SshClientError('invalid', 'another command is in flight'));
    }

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
    } catch (err) {
      this.failWaiter(
        err instanceof Error ? err : new SshClientError('closed', String(err)),
        false,
      );
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

      const onAbort = (): void => {
        this.failWaiter(new SshClientError('closed', 'aborted'), true);
      };

      const gen = ++this.generation;
      const idleTimeoutMs = args.idleTimeoutMs ?? 0;
      const waiter: Waiter = {
        mode: args.mode,
        start: this.buf.length,
        pager: createPagerState(),
        maxPages: args.maxPages,
        maxOutputBytes: args.maxOutputBytes,
        command: args.command,
        settleTimer: null,
        pokeTimer: null,
        idleTimer: null,
        idleTimeoutMs,
        signal: args.signal,
        onAbort,
        timer: setTimeout(() => {
          if (this.generation !== gen) return;
          this.failWaiter(new SshClientError('timeout', args.timeoutMessage), args.mode === 'command');
        }, args.timeoutMs),
        resolve: (value) => {
          this.clearWaiter();
          this.clearBuf();
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
          if (this.waiter !== waiter) return;
          try {
            this.stream.write('\r');
          } catch {
            /* ignore */
          }
        }, Math.min(500, Math.floor(args.timeoutMs / 4)));
      }

      queueMicrotask(() => this.evaluateWaiter());
    });
  }

  private armIdleTimer(w: Waiter): void {
    if (w.idleTimer) clearTimeout(w.idleTimer);
    if (w.mode !== 'command' || w.idleTimeoutMs <= 0) {
      w.idleTimer = null;
      return;
    }
    w.idleTimer = setTimeout(() => {
      if (this.waiter !== w) return;
      this.failWaiter(
        new SshClientError('timeout', `idle timeout after ${w.idleTimeoutMs}ms with no output`),
        true,
      );
    }, w.idleTimeoutMs);
  }

  private failWaiter(err: Error, resync: boolean): void {
    const w = this.waiter;
    if (!w) return;
    const wasPaging = w.pager.pages > 0 || w.pager.quitSent;
    this.clearWaiter();
    if (resync) {
      this.resync(wasPaging);
    }
    w.reject(err);
  }

  private clearWaiter(): void {
    const w = this.waiter;
    this.waiter = null;
    if (!w) return;
    clearTimeout(w.timer);
    if (w.settleTimer) clearTimeout(w.settleTimer);
    if (w.pokeTimer) clearTimeout(w.pokeTimer);
    if (w.idleTimer) clearTimeout(w.idleTimer);
    if (w.onAbort && w.signal) {
      w.signal.removeEventListener('abort', w.onAbort);
    }
  }

  private readonly onData = (chunk: Buffer): void => {
    this.appendBuf(chunk.toString('utf8'));
    if (this.waiter) {
      this.armIdleTimer(this.waiter);
    }
    if (!this.waiter) {
      this.trimIdleBuffer();
      return;
    }
    this.evaluateWaiter();
  };

  private evaluateWaiter(): void {
    const w = this.waiter;
    if (!w) return;

    const segment = this.buf.slice(w.start);

    if (w.mode === 'command' && Buffer.byteLength(segment, 'utf8') > w.maxOutputBytes) {
      this.failWaiter(
        new SshClientError('invalid', `command output exceeded maxOutputBytes=${w.maxOutputBytes}`),
        true,
      );
      return;
    }

    if (w.mode === 'command') {
      const pagesBefore = w.pager.pages;
      const quitBefore = w.pager.quitSent;
      handlePagerIfNeeded(segment, this.stream, w.pager, w.maxPages);
      // If we keyed the pager, re-evaluate on next tick after fake/remote responds.
      if (w.pager.pages !== pagesBefore || w.pager.quitSent !== quitBefore) {
        queueMicrotask(() => this.evaluateWaiter());
      }
    }

    if (!matchesPromptTail(segment, this.promptRegex)) {
      return;
    }

    if (w.settleTimer) clearTimeout(w.settleTimer);
    const settleGen = this.generation;
    w.settleTimer = setTimeout(() => {
      if (this.waiter !== w || this.generation !== settleGen) return;

      // Re-read buffer so late chunks arriving during settleMs are included.
      const current = this.buf.slice(w.start);
      if (!matchesPromptTail(current, this.promptRegex)) {
        return;
      }

      if (w.mode === 'resync') {
        this.clearWaiter();
        this.clearBuf();
        w.resolve('');
        return;
      }

      if (w.mode === 'ready') {
        w.resolve(current);
        return;
      }

      const out = cleanOutput(current, w.command, this.promptRegex);
      if (w.pager.quitSent && w.pager.pages >= w.maxPages) {
        this.failWaiter(new SshClientError('timeout', `pager exceeded maxPages=${w.maxPages}`), false);
        this.clearBuf();
        return;
      }
      w.resolve(out);
    }, this.settleMs);
  }

  private trimIdleBuffer(): void {
    if (this.partsBytes <= this.idleBufferMaxBytes) {
      return;
    }
    let joined = this.buf;
    while (Buffer.byteLength(joined, 'utf8') > this.idleBufferMaxBytes && joined.length > 0) {
      joined = joined.slice(Math.floor(joined.length / 2));
    }
    this.setBuf(joined);
  }

  private resync(wasPaging: boolean): void {
    this.clearBuf();
    try {
      this.stream.write(wasPaging ? 'q' : '\r');
    } catch {
      return;
    }

    void this.beginWait({
      mode: 'resync',
      command: '',
      maxPages: 1,
      maxOutputBytes: Number.MAX_SAFE_INTEGER,
      timeoutMs: 5_000,
      timeoutMessage: 'resync timed out',
      settleMs: this.settleMs,
    }).catch(() => {
      /* best-effort */
    });
  }

  private readonly onClosed = (err?: unknown): void => {
    const w = this.waiter;
    this.clearWaiter();
    if (w) {
      w.reject(new SshClientError('closed', closedMessage(err)));
    }
  };
}

/** Standalone wait used by unit tests that do not construct ShellIo. */
export function waitForPrompt(stream: ShellStream, opts: PromptWaitOptions): Promise<string> {
  const io = new ShellIo(stream, {
    promptRegex: opts.promptRegex,
    settleMs: opts.settleMs,
    idleBufferMaxBytes: 64 * 1024,
  });
  return io
    .waitForReady({
      promptRegex: opts.promptRegex,
      settleMs: opts.settleMs,
      timeoutMs: opts.timeoutMs,
      timeoutMessage: opts.timeoutMessage,
      readyPoke: opts.readyPoke,
    })
    .finally(() => io.detach());
}

export function runCommandOnShell(
  stream: ShellStream,
  command: string,
  opts: Pick<
    ResolvedOptions,
    'promptRegex' | 'settleMs' | 'commandTimeoutMs' | 'maxPages' | 'maxOutputBytes' | 'idleBufferMaxBytes'
  >,
  overrides?: { timeoutMs?: number; signal?: AbortSignal; maxPages?: number; maxOutputBytes?: number },
): Promise<string> {
  const io = new ShellIo(stream, opts);
  return io.runCommand(command, opts, overrides).finally(() => io.detach());
}

export function cleanOutput(raw: string, command: string, promptRegex: RegExp = /(?:>|#)\s*$/m): string {
  const echoStrip = /^\s*(?:>|#)\s*/;
  let output = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  output = output.replace(/-{3}\s*MORE\s*-{3}/gi, '');

  if (command) {
    output = output.replace(echoRegex(command), '');
  }

  const lines: string[] = [];
  for (const line of output.split('\n')) {
    const trimmed = line.replace(echoStrip, '').trimEnd();
    if (trimmed.trim() === '') continue;
    lines.push(trimmed);
  }

  while (lines.length > 0) {
    const last = lines[lines.length - 1];
    if (last === undefined) break;
    if (matchesPromptTail(last, promptRegex)) {
      lines.pop();
      continue;
    }
    break;
  }

  return lines.join('\n').trim();
}

function echoRegex(command: string): RegExp {
  return new RegExp(`^\\s*(?:>|#)?\\s*${escapeRegex(command)}\\s*(?:\\n|$)`, 'gmu');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function matchesPromptTail(buffer: string, promptRegex: RegExp): boolean {
  const tail = buffer.slice(buffer.lastIndexOf('\n') + 1);
  promptRegex.lastIndex = 0;
  return promptRegex.test(tail);
}

function normalizePromptRegex(promptRegex: RegExp): RegExp {
  if (!promptRegex.flags.includes('g')) {
    return promptRegex;
  }
  return new RegExp(promptRegex.source, promptRegex.flags.replaceAll('g', ''));
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
