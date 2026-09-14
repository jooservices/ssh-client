import { SshClientError } from './errors.js';
import type { ResolvedOptions } from './options.js';
import { handlePagerIfNeeded, type PagerState } from './pager.js';

export interface ShellStream {
  write: (data: string) => unknown;
  on: (event: 'data', cb: (chunk: Buffer) => void) => unknown;
  removeListener: (event: 'data', cb: (chunk: Buffer) => void) => unknown;
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

    const cleanup = (): void => {
      stream.removeListener('data', onData);
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
      opts.promptRegex.lastIndex = 0;

      if (opts.promptRegex.test(buf)) {
        if (settleTimer) {
          clearTimeout(settleTimer);
        }

        settleTimer = setTimeout(settle, opts.settleMs);
      }
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new SshClientError('timeout', opts.timeoutMessage));
    }, opts.timeoutMs);

    stream.on('data', onData);
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

    const cleanup = (): void => {
      stream.removeListener('data', onData);
      clearTimeout(timer);

      if (settleTimer) {
        clearTimeout(settleTimer);
      }

      signal?.removeEventListener('abort', onAbort);
    };

    const finish = (): void => {
      cleanup();
      resolve(cleanOutput(buf, command, opts.promptRegex));
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

      opts.promptRegex.lastIndex = 0;

      if (opts.promptRegex.test(buf)) {
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

    const timer = setTimeout(() => {
      cleanup();
      reject(new SshClientError('timeout', `command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    signal?.addEventListener('abort', onAbort, { once: true });
    stream.on('data', onData);
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

    promptRegex.lastIndex = 0;

    if (promptRegex.test(last)) {
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
