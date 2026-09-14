import { SshClientError } from './errors.js';

const MORE_RE = /---\s*MORE\s*---/i;

export interface PagerState {
  pages: number;
  /** Index into the current command segment after the last handled MORE. */
  morePos: number;
  quitSent: boolean;
}

export function createPagerState(): PagerState {
  return { pages: 0, morePos: 0, quitSent: false };
}

/**
 * Respond to each NEW `--- MORE ---` marker once (MCP morePos style).
 * Space-scrolls until maxPages, then sends `q` once so the shell can leave the pager.
 * Does not mutate away markers from `segment` (cleanOutput strips them later).
 */
export function handlePagerIfNeeded(
  segment: string,
  stream: { write: (data: string) => unknown },
  state: PagerState,
  maxPages: number,
): { segment: string; quitSent: boolean } {
  for (;;) {
    const slice = segment.slice(state.morePos);
    const match = MORE_RE.exec(slice);
    if (!match || match.index === undefined) {
      break;
    }

    state.morePos += match.index + match[0].length;

    if (state.pages >= maxPages) {
      if (!state.quitSent) {
        stream.write('q');
        state.quitSent = true;
      }
      break;
    }

    state.pages += 1;
    stream.write(' ');
  }

  return { segment, quitSent: state.quitSent };
}

export function pagerExceededError(maxPages: number): SshClientError {
  return new SshClientError('timeout', `pager exceeded maxPages=${maxPages}`);
}
