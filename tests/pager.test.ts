import { describe, expect, it } from 'vitest';
import { SshClientError } from '../src/errors.js';
import { createPagerState, handlePagerTail, markerOnTail, pagerExceededError, removeHandledMarkers } from '../src/pager.js';

describe('handlePagerTail', () => {
  it('writes a space when the marker is the unterminated tail', () => {
    const writes: string[] = [];
    const state = createPagerState();

    expect(handlePagerTail('--- more ---', { write: (data: string) => writes.push(data) }, state, 3)).toBe(true);
    expect(writes).toEqual([' ']);
    expect(state.pages).toBe(1);
    expect(state.handled).toBe(1);
  });

  it('leaves a line without a marker unchanged', () => {
    const writes: string[] = [];
    const state = createPagerState();

    expect(markerOnTail('routing table complete')).toBe(false);
    expect(handlePagerTail('routing table complete', { write: (data: string) => writes.push(data) }, state, 3)).toBe(false);
    expect(writes).toEqual([]);
    expect(state.pages).toBe(0);
  });

  it('sends q once when the page budget is exhausted', () => {
    const writes: string[] = [];
    const state = createPagerState();
    state.pages = 1;

    expect(handlePagerTail('--- MORE ---', { write: (data: string) => writes.push(data) }, state, 1)).toBe(true);
    expect(writes).toEqual(['q']);
    expect(state.quitSent).toBe(true);
  });

  it('does not send a second q for a tail that was already answered', () => {
    const writes: string[] = [];
    const state = createPagerState();
    state.pages = 2;
    state.quitSent = true;
    state.answeredTail = '--- MORE ---';

    expect(handlePagerTail('--- MORE ---', { write: (data: string) => writes.push(data) }, state, 1)).toBe(false);
    expect(writes).toEqual([]);
    expect(state.quitSent).toBe(true);
  });

  it('does not re-fire space for the same tail', () => {
    const writes: string[] = [];
    const state = createPagerState();

    handlePagerTail('--- MORE ---', { write: (data: string) => writes.push(data) }, state, 5);
    handlePagerTail('--- MORE ---', { write: (data: string) => writes.push(data) }, state, 5);

    expect(writes).toEqual([' ']);
    expect(state.pages).toBe(1);
  });

  it('exports pagerExceededError as a limit error', () => {
    expect(pagerExceededError(2)).toBeInstanceOf(SshClientError);
    expect(pagerExceededError(2).code).toBe('limit');
  });

  it('keeps markers once the handled count is used and does not quit twice', () => {
    const writes: string[] = [];
    const state = createPagerState();
    state.pages = 2;
    state.quitSent = true;

    expect(handlePagerTail('--- MORE ---', { write: (data: string) => writes.push(data) }, state, 1)).toBe(true);
    expect(writes).toEqual([]);
    expect(removeHandledMarkers('a --- MORE --- b --- MORE ---', 1)).toBe('a  b --- MORE ---');
    expect(removeHandledMarkers('a --- MORE ---', 0)).toBe('a --- MORE ---');
  });

  it('does not treat a marker that already has a following line as the tail', () => {
    expect(markerOnTail('--- MORE ---\nb')).toBe(false);
    expect(markerOnTail('tail --- MORE ---')).toBe(true);
  });
});
