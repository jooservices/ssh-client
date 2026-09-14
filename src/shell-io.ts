import { SshClientError } from './errors.js';
import type { ResolvedOptions } from './options.js';
import { handlePagerIfNeeded, type PagerState } from './pager.js';

export interface ShellStream {
  write: (data: string) => unknown;
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
}

export function waitForPrompt(stream: ShellStream, opts: PromptWaitOptions): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let buf = '';
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    const promptRegex = normalizePromptRegex(opts.promptRegex);

    const cleanup = (): void => {
      stream.removeListener('data', onData);
      stream.removeListener('close', onClosed);
      stream.removeListener('end', onClosed);
      stream.removeListener('error', onClosed);
      clearTimeout(timer);

      if (settleTimer) {
        clearTimeout(settleTimer);
      }
    };

    const settle = (): void => {
      cleanup();
      resolve(buf);
    };

    const onData = (chunk: Buffer): void => {
      buf += chunk.toString('utf8');

      if (matchesPromptTail(buf, promptRegex)) {
        if (settleTimer) {
          clearTimeout(settleTimer);
        }

        settleTimer = setTimeout(settle, opts.settleMs);
      }
    };

    const onClosed = (err?: unknown): void => {
      cleanup();
      reject(new SshClientError('closed', closedMessage(err)));
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new SshClientError('timeout', opts.timeoutMessage));
    }, opts.timeoutMs);

    stream.on('data', onData);
    stream.on('close', onClosed);
    stream.on('end', onClosed);
    stream.on('error', onClosed);
  });
}

export function runCommandOnShell(
  stream: ShellStream,
  command: string,
  opts: Pick<ResolvedOptions, 'promptRegex' | 'settleMs' | 'commandTimeoutMs' | 'maxPages' | 'maxOutputBytes'>,
  overrides?: { timeoutMs?: number; signal?: AbortSignal; maxPages?: number; maxOutputBytes?: number },
): Promise<string> {
  const timeoutMs = overrides?.timeoutMs ?? opts.commandTimeoutMs;
  const maxPages = overrides?.maxPages ?? opts.maxPages;
  const maxOutputBytes = overrides?.maxOutputBytes ?? opts.maxOutputBytes;
  const signal = overrides?.signal;

  return new Promise<string>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new SshClientError('closed', 'aborted'));
      return;
    }

    let buf = '';
    const pager: PagerState = { pages: 0 };
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    const promptRegex = normalizePromptRegex(opts.promptRegex);

    const cleanup = (): void => {
      stream.removeListener('data', onData);
      stream.removeListener('close', onClosed);
      stream.removeListener('end', onClosed);
      stream.removeListener('error', onClosed);
      clearTimeout(timer);

      if (settleTimer) {
        clearTimeout(settleTimer);
      }

      signal?.removeEventListener('abort', onAbort);
    };

    const finish = (): void => {
      cleanup();
      resolve(cleanOutput(buf, command, promptRegex));
    };

    const onData = (chunk: Buffer): void => {
      buf += chunk.toString('utf8');

      if (Buffer.byteLength(buf, 'utf8') > maxOutputBytes) {
        cleanup();
        reject(new SshClientError('invalid', `command output exceeded maxOutputBytes=${maxOutputBytes}`));
        return;
      }

      try {
        buf = handlePagerIfNeeded(buf, stream, pager, maxPages);
      } catch (err) {
        cleanup();
        reject(err);
        return;
      }

      if (matchesPromptTail(buf, promptRegex)) {
        if (settleTimer) {
          clearTimeout(settleTimer);
        }

        settleTimer = setTimeout(finish, opts.settleMs);
      }
    };

    const onAbort = (): void => {
      cleanup();
      reject(new SshClientError('closed', 'aborted'));
    };

    const onClosed = (err?: unknown): void => {
      cleanup();
      reject(new SshClientError('closed', closedMessage(err)));
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new SshClientError('timeout', `command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    signal?.addEventListener('abort', onAbort, { once: true });
    stream.on('data', onData);
    stream.on('close', onClosed);
    stream.on('end', onClosed);
    stream.on('error', onClosed);
    stream.write(`${command}\r`);
  });
}

export function cleanOutput(raw: string, command: string, promptRegex: RegExp = /(?:>|#)\s*$/m): string {
  let output = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  output = output.replace(echoRegex(command), '');
  const lines = output.split('\n');

  while (lines.length > 0 && lines[0]?.trim() === '') {
    lines.shift();
  }

  while (lines.length > 0) {
    const last = lines[lines.length - 1];

    if (last === undefined || last.trim() === '') {
      lines.pop();
      continue;
    }

    if (matchesPromptTail(last, promptRegex)) {
      lines.pop();
      continue;
    }

    break;
  }

  return lines.join('\n').trim();
}

function echoRegex(command: string): RegExp {
  return new RegExp(`^[^\\n]*${escapeRegex(command)}\\s*(?:\\n|$)`, 'gmu');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesPromptTail(buffer: string, promptRegex: RegExp): boolean {
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
