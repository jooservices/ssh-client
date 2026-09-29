import { describe, expect, it } from 'vitest';
import { isPromptLine, lineFullyMatches, looksLikeReadyPrompt, normalizePromptRegex } from '../src/prompt.js';

describe('prompt matching', () => {
  it('treats a ready tail that ends in a prompt character as ready-only', () => {
    expect(looksLikeReadyPrompt('router# ')).toBe(true);
    expect(looksLikeReadyPrompt('user@host:~$ ')).toBe(true);
    expect(looksLikeReadyPrompt('config value #')).toBe(true);
    expect(looksLikeReadyPrompt('hello')).toBe(false);
    expect(looksLikeReadyPrompt('   ')).toBe(false);
  });

  it('strips the global flag and still matches the next line', () => {
    const regex = /^router# $/gu;

    expect(normalizePromptRegex(regex).flags.includes('g')).toBe(false);
    expect(lineFullyMatches('router# ', regex)).toBe(true);
    expect(lineFullyMatches('router# ', regex)).toBe(true);
    expect(lineFullyMatches('router# extra', /^router# $/u)).toBe(false);
    expect(lineFullyMatches('xrouter# ', /^router# $/u)).toBe(false);
  });

  it('custom regex is full line', () => {
    const promptRegex = /^user@host:\S+\$ $/u;

    expect(isPromptLine('user@host:~$ ', null, promptRegex)).toBe(true);
    expect(isPromptLine('user@host:~$ $ extra', null, promptRegex)).toBe(false);
    expect(isPromptLine('user@host:~$ ', 'other', null)).toBe(false);
    expect(isPromptLine('user@host:~$ ', 'user@host:~$ ', null)).toBe(true);
  });

  it('regex metacharacters in identity stay literal', () => {
    expect(isPromptLine('axb# ', 'a.b# ', null)).toBe(false);
    expect(isPromptLine('a.b# ', 'a.b# ', null)).toBe(true);
  });
});
