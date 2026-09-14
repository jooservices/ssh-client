import { describe, expect, it } from 'vitest';
import { SshClientError } from '../src/errors.js';
import { handlePagerIfNeeded, type PagerState } from '../src/pager.js';

describe('handlePagerIfNeeded', () => {
  it('writes a space, bumps page count, and removes a MORE marker', () => {
    const writes: string[] = [];
    const state: PagerState = { pages: 0 };
    const buffer = `interface statistics\n--- more ---`;

    const cleaned = handlePagerIfNeeded(buffer, { write: (data: string) => writes.push(data) }, state, 3);

    expect(cleaned).toBe('interface statistics\n');
    expect(writes).toEqual([' ']);
    expect(state.pages).toBe(1);
  });

  it('leaves buffers without a MORE marker unchanged', () => {
    const writes: string[] = [];
    const state: PagerState = { pages: 0 };
    const buffer = 'routing table complete';

    expect(handlePagerIfNeeded(buffer, { write: (data: string) => writes.push(data) }, state, 3)).toBe(buffer);
    expect(writes).toEqual([]);
    expect(state.pages).toBe(0);
  });

  it('throws timeout when the page budget is exhausted', () => {
    const state: PagerState = { pages: 1 };

    expect(() => handlePagerIfNeeded('--- MORE ---', { write: () => undefined }, state, 1)).toThrow(SshClientError);
    expect(() => handlePagerIfNeeded('--- MORE ---', { write: () => undefined }, state, 1)).toThrow(/maxPages=1/u);
  });
});
