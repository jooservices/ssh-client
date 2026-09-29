import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { OutputAccumulator, cleanOutput } from '../src/output-accumulator.js';
import { isPromptLine, lineFullyMatches, looksLikeReadyPrompt } from '../src/prompt.js';

describe('transport properties', () => {
  it('joins UTF-8 split at arbitrary byte offsets', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 80 }),
        fc.array(fc.integer({ min: 0, max: 64 }), { maxLength: 8 }),
        (text, cuts) => {
        const encoded = Buffer.from(text, 'utf8');
        const whole = new OutputAccumulator();
        whole.push(encoded);

        const points = [...new Set(cuts.map((cut) => cut % (encoded.length + 1)))].sort((left, right) => left - right);
        const split = new OutputAccumulator();
        let from = 0;

        for (const point of points) {
          if (point > from) {
            split.push(encoded.subarray(from, point));
            from = point;
          }
        }

        if (from < encoded.length) {
          split.push(encoded.subarray(from));
        }

        expect(split.snapshot()).toBe(whole.snapshot());
      }),
    );
  });

  it('strips one echo and the trailing prompt without dropping the body', () => {
    const body = fc.string({ minLength: 1, maxLength: 40 }).filter((value) => !/[\r\n]/u.test(value));

    fc.assert(
      fc.property(body, body, body, (command, middle, prompt) => {
        fc.pre(command !== prompt && middle !== command && prompt !== `# ${middle}`);
        const cleaned = cleanOutput(`${command}\n  ${middle}\n# ${middle}\n${prompt}`, command, prompt);

        expect(cleaned).toBe(`  ${middle}\n# ${middle}`);
      }),
    );
  });

  it('matches a command prompt only by exact identity or a full-line regex', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (line, identity) => {
        expect(isPromptLine(line, identity, null)).toBe(line === identity);
        expect(isPromptLine(line, null, null)).toBe(false);

        const literal = new RegExp(`^${escapeRegExp(line)}$`, 'u');

        expect(lineFullyMatches(line, literal)).toBe(true);
        expect(lineFullyMatches(`${line} `, literal)).toBe(false);
      }),
    );
  });

  it('does not treat a hash inside the line as the ready prompt', () => {
    expect(looksLikeReadyPrompt('config value #')).toBe(true);
    expect(isPromptLine('config value #', 'router# ', null)).toBe(false);
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
