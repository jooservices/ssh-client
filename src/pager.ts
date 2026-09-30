import { SshClientError } from './errors.js';

const MORE_RE = /---\s*MORE\s*---\s*$/i;

export interface PagerState {
  pages: number;
  /** Tail already answered, so the same marker is not scrolled twice. */
  answeredTail: string | null;
  /** Display-line generation of `answeredTail`. A later line may repeat the marker text. */
  answeredEpoch: number;
  quitSent: boolean;
  handled: number;
}

export function createPagerState(): PagerState {
  return { pages: 0, answeredTail: null, answeredEpoch: -1, quitSent: false, handled: 0 };
}

/** True when the unterminated line is a pager prompt, not marker text followed by a newline. */
export function markerOnTail(line: string): boolean {
  return MORE_RE.test(line);
}

/**
 * Page only when the marker is the current tail. A marker that already ended
 * with a newline is ordinary output and is left untouched.
 */
export function handlePagerTail(
  line: string,
  stream: { write: (data: string) => unknown },
  state: PagerState,
  maxPages: number,
): boolean {
  if (!markerOnTail(line) || state.answeredTail === line) {
    return false;
  }

  state.answeredTail = line;
  state.handled += 1;

  if (state.pages >= maxPages) {
    if (!state.quitSent) {
      stream.write('q');
      state.quitSent = true;
    }

    return true;
  }

  state.pages += 1;
  stream.write(' ');

  return true;
}

export function pagerExceededError(maxPages: number): SshClientError {
  return new SshClientError('limit', `pager exceeded maxPages=${maxPages}`);
}

export function removeHandledMarkers(text: string, handled: number): string {
  if (handled <= 0) {
    return text;
  }

  let left = handled;

  return text.replace(/---\s*MORE\s*---/giu, (marker) => {
    if (left <= 0) {
      return marker;
    }

    left -= 1;

    return '';
  });
}
