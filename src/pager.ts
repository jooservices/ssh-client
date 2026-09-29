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

/**
 * Scan `text` for pager markers. Returns the unscanned suffix, keeping a short
 * tail so a marker split across chunks is still visible on the next push.
 */
export function scanPagerText(
  text: string,
  stream: { write: (data: string) => unknown },
  state: PagerState,
  maxPages: number,
): string {
  const local: PagerState = { pages: state.pages, morePos: 0, quitSent: state.quitSent };
  handlePagerIfNeeded(text, stream, local, maxPages);
  state.pages = local.pages;
  state.quitSent = local.quitSent;
  const rest = text.slice(local.morePos);

  return rest.length > 24 ? rest.slice(rest.length - 24) : rest;
}
