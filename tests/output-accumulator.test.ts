import { describe, expect, it } from 'vitest';
import { cleanOutput, OutputAccumulator } from '../src/output-accumulator.js';

const prompt = 'router# ';

describe('OutputAccumulator', () => {
  it('utf-8 two-byte split', () => {
    const text = 'à';
    const bytes = Buffer.from(text);
    const accumulator = new OutputAccumulator();

    expect(bytes.length).toBe(2);
    accumulator.push(bytes.subarray(0, 1));
    accumulator.push(bytes.subarray(1));

    expect(accumulator.snapshot()).toBe(text);
  });

  it('utf-8 three-byte split', () => {
    const text = '€';
    const bytes = Buffer.from(text);
    const accumulator = new OutputAccumulator();

    expect(bytes.length).toBe(3);
    accumulator.push(bytes.subarray(0, 1));
    accumulator.push(bytes.subarray(1, 2));
    accumulator.push(bytes.subarray(2));

    expect(accumulator.snapshot()).toBe(text);
  });

  it('utf-8 four-byte split', () => {
    const text = '😀';
    const bytes = Buffer.from(text);
    const accumulator = new OutputAccumulator();

    expect(bytes.length).toBe(4);

    for (let index = 0; index < bytes.length; index += 1) {
      accumulator.push(bytes.subarray(index, index + 1));
    }

    expect(accumulator.snapshot()).toBe(text);
  });

  it('utf-8 many characters arbitrary chunks', () => {
    const text = 'àé€😀'.repeat(12);
    const bytes = Buffer.from(text);
    const accumulator = new OutputAccumulator();

    for (let index = 0; index < bytes.length; index += 1) {
      accumulator.push(bytes.subarray(index, index + 1));
    }

    expect(accumulator.snapshot()).toBe(text);
    expect(accumulator.currentLine()).toBe(text);
  });

  it('joins a CR and LF that arrive in different chunks into one newline', () => {
    const accumulator = new OutputAccumulator();

    accumulator.push(Buffer.from('a\r'));
    accumulator.push(Buffer.from('\nb'));

    expect(accumulator.snapshot()).toBe('a\nb');
    expect(accumulator.currentLine()).toBe('b');
  });

  it('flushes a trailing CR on snapshot and trims idle bytes', () => {
    const accumulator = new OutputAccumulator();

    accumulator.push(Buffer.from('abcdef\r'));
    expect(accumulator.snapshot()).toBe('abcdef\n');

    accumulator.push(Buffer.from('0123456789'));
    accumulator.trimToMaxBytes(4);

    expect(Buffer.byteLength(accumulator.snapshot())).toBeLessThanOrEqual(4);
  });

  it('20k over 10k ratio', () => {
    const ratio = medianRatio();

    expect(ratio).toBeLessThanOrEqual(3);
    expect(Number.isFinite(ratio)).toBe(true);
  });
});

describe('cleanOutput', () => {
  it('preserves indent blank and markers', () => {
    const raw = `show\n  indented\n\n# comment\n> quote\nvalue  #\n${prompt}`;

    expect(cleanOutput(raw, 'show', prompt)).toBe('  indented\n\n# comment\n> quote\nvalue  #');
  });

  it('removes only the first echo', () => {
    const raw = `show\nvalue one\nshow\nvalue two\n${prompt}`;

    expect(cleanOutput(raw, 'show', prompt)).toBe('value one\nshow\nvalue two');
  });

  it('echo with prompt prefix', () => {
    expect(cleanOutput(`router# show\nvalue\n${prompt}`, 'show', prompt)).toBe('value');
    expect(cleanOutput(`router#show\nvalue\n${prompt}`, 'show', prompt)).toBe('value');
    expect(cleanOutput(`other\nshow\n${prompt}`, 'show', prompt)).toBe('other\nshow');
  });

  it('keeps a body that does not end with the prompt', () => {
    expect(cleanOutput('just value', '', prompt)).toBe('just value');
  });

  it('empty output', () => {
    expect(cleanOutput(`show\n${prompt}`, 'show', prompt)).toBe('');
    expect(cleanOutput(prompt, '', prompt)).toBe('');
    expect(cleanOutput('value\n', '', '')).toBe('value\n');
  });

  it('pager marker removed', () => {
    expect(cleanOutput(`foo\n--- MORE ---\nbar\n${prompt}`, 'cmd', prompt)).toBe('foo\n\nbar');
  });

  it('crlf and lone cr', () => {
    expect(cleanOutput(`a\r\nb\rc\n${prompt}`, 'noop', prompt)).toBe('a\nb\nc');
  });
});

function timePushes(count: number): number {
  const chunk = Buffer.from('x');
  const samples: number[] = [];

  for (let run = 0; run < 5; run += 1) {
    const accumulator = new OutputAccumulator();
    const started = performance.now();

    for (let index = 0; index < count; index += 1) {
      accumulator.push(chunk);
    }

    accumulator.snapshot();
    samples.push(performance.now() - started);
  }

  samples.sort((left, right) => left - right);

  return samples[2] ?? 0;
}

function medianRatio(): number {
  let small = 10_000;
  let large = 20_000;
  let smallMs = timePushes(small);
  let largeMs = timePushes(large);

  while ((smallMs === 0 || largeMs === 0) && large < 320_000) {
    small *= 2;
    large = small * 2;
    smallMs = timePushes(small);
    largeMs = timePushes(large);
  }

  return largeMs / smallMs;
}
