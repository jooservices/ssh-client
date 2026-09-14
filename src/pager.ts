import { SshClientError } from './errors.js';

const MORE_RE = /---\s*MORE\s*---/i;

export interface PagerState {
  pages: number;
}

export function handlePagerIfNeeded(
  buf: string,
  stream: { write: (data: string) => unknown },
  state: PagerState,
  maxPages: number,
): string {
  if (!MORE_RE.test(buf)) {
    return buf;
  }

  if (state.pages >= maxPages) {
    throw new SshClientError('timeout', `pager exceeded maxPages=${maxPages}`);
  }

  state.pages += 1;
  stream.write(' ');

  return buf.replace(MORE_RE, '');
}
