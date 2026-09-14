import { describe, expect, it } from 'vitest';
import { SshClientError } from '../src/errors.js';
import { createPagerState, handlePagerIfNeeded } from '../src/pager.js';

describe('handlePagerIfNeeded', () => {
  it('writes a space, bumps page count, and advances morePos', () => {
    const writes: string[] = [];
    const state = createPagerState();
    const buffer = `interface statistics\n--- more ---`;

    const cleaned = handlePagerIfNeeded(buffer, { write: (data: string) => writes.push(data) }, state, 3);

    expect(cleaned.segment).toBe(buffer);
    expect(writes).toEqual([' ']);
    expect(state.pages).toBe(1);
    expect(state.morePos).toBeGreaterThan(0);
  });

  it('leaves buffers without a MORE marker unchanged', () => {
    const writes: string[] = [];
    const state = createPagerState();
    const buffer = 'routing table complete';

    expect(handlePagerIfNeeded(buffer, { write: () => undefined }, state, 3).segment).toBe(buffer);
    expect(writes).toEqual([]);
    expect(state.pages).toBe(0);
  });

  it('sends q once when the page budget is exhausted instead of only throwing', () => {
    const writes: string[] = [];
    const state = createPagerState();
    state.pages = 1;

    const result = handlePagerIfNeeded('--- MORE ---', { write: (d) => writes.push(d) }, state, 1);

    expect(writes).toEqual(['q']);
    expect(state.quitSent).toBe(true);
    expect(result.quitSent).toBe(true);
  });

  it('does not send a second q when quit was already sent for later MORE markers', () => {
    const writes: string[] = [];
    const state = createPagerState();
    state.pages = 2;
    state.quitSent = true;

    handlePagerIfNeeded('--- MORE ---', { write: (d) => writes.push(d) }, state, 1);

    expect(writes).toEqual([]);
    expect(state.quitSent).toBe(true);
  });

  it('does not re-fire space for the same MORE marker', () => {
    const writes: string[] = [];
    const state = createPagerState();
    const buffer = 'a\n--- MORE ---\nb';

    handlePagerIfNeeded(buffer, { write: (d) => writes.push(d) }, state, 5);
    handlePagerIfNeeded(buffer, { write: (d) => writes.push(d) }, state, 5);

    expect(writes).toEqual([' ']);
    expect(state.pages).toBe(1);
  });

  it('exports pagerExceededError helper', async () => {
    const { pagerExceededError } = await import('../src/pager.js');
    expect(pagerExceededError(2)).toBeInstanceOf(SshClientError);
  });
});
