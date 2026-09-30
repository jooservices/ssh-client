import { StringDecoder } from 'node:string_decoder';
import { removeHandledMarkers } from './pager.js';

type AnsiState = 'text' | 'esc' | 'csi' | 'osc' | 'osc-esc' | 'esc-int';

interface AnsiCarry {
  state: AnsiState;
}

/**
 * Incremental UTF-8 decoder. Lone CR stays in the snapshot so callers can
 * apply overwrite; CR followed by LF is one newline. The display tail is the
 * visible current line after overwrite.
 */
export class OutputAccumulator {
  private parts: string[] = [];
  private line = '';
  private col = 0;
  private pendingCr = 0;
  private decoder = new StringDecoder('utf8');
  private ansi: AnsiCarry = { state: 'text' };
  byteLength = 0;
  /** Increments on every newline so a later pager marker is a new line. */
  lineEpoch = 0;

  constructor(private readonly maxPromptLength = 256) {}

  push(chunk: Buffer): void {
    this.byteLength += chunk.length;
    this.ingest(this.decoder.write(chunk));
  }

  /** Discard one idle chunk and forget any partial UTF-8 or ANSI sequence. */
  drop(chunk: Buffer): void {
    void chunk.byteLength;
    this.decoder = new StringDecoder('utf8');
    this.pendingCr = 0;
    this.ansi = { state: 'text' };
  }

  snapshot(): string {
    this.ingest(this.decoder.end());
    this.decoder = new StringDecoder('utf8');

    if (this.pendingCr > 0) {
      this.parts.push('\r'.repeat(this.pendingCr));
      this.col = 0;
      this.pendingCr = 0;
    }

    return this.parts.join('');
  }

  clear(): void {
    this.parts = [];
    this.line = '';
    this.col = 0;
    this.pendingCr = 0;
    this.byteLength = 0;
    this.decoder = new StringDecoder('utf8');
    this.ansi = { state: 'text' };
  }

  currentLine(): string {
    return this.line;
  }

  lineTooLong(): boolean {
    return this.line.length > this.maxPromptLength;
  }

  /** Tail used for pager detection, bounded so a long line cannot hide a marker. */
  pagerTail(): string {
    if (this.line.length <= this.maxPromptLength) {
      return this.line;
    }

    return this.line.slice(-this.maxPromptLength);
  }

  private ingest(text: string): void {
    if (text.length === 0) {
      return;
    }

    this.appendNormalized(stripAnsiChunk(text, this.ansi));
  }

  private appendNormalized(text: string): void {
    let run = '';

    const flushRun = (): void => {
      if (run.length === 0) {
        return;
      }

      this.parts.push(run);

      for (const ch of run) {
        this.writeDisplay(ch);
      }

      run = '';
    };

    for (const ch of text) {
      if (ch === '\r') {
        flushRun();
        this.pendingCr += 1;
        continue;
      }

      if (ch === '\n') {
        flushRun();
        this.pendingCr = 0;
        this.parts.push('\n');
        this.line = '';
        this.col = 0;
        this.lineEpoch += 1;
        continue;
      }

      if (this.pendingCr > 0) {
        this.parts.push('\r'.repeat(this.pendingCr));
        this.col = 0;
        this.pendingCr = 0;
      }

      run += ch;
    }

    flushRun();
  }

  private writeDisplay(ch: string): void {
    if (this.col < this.line.length) {
      this.line = this.line.slice(0, this.col) + ch + this.line.slice(this.col + ch.length);
    } else {
      this.line += ch;
    }

    this.col += ch.length;
  }
}

export function cleanOutput(
  raw: string,
  command: string,
  promptLine: string,
  previousPrompt = '',
  handledMarkers = 0,
): string {
  let text = stripAnsi(raw);
  text = collapseCrLf(text);
  text = stripFinalPrompt(text, promptLine);
  text = stripEcho(text, command, previousPrompt, promptLine);
  text = applyCarriageReturns(text);

  return removeHandledMarkers(text, handledMarkers);
}

function stripFinalPrompt(text: string, promptLine: string): string {
  if (promptLine.length === 0) {
    return text;
  }

  const cut = text.lastIndexOf('\n');
  const last = text.slice(cut + 1);

  if (applyCrLine(last) !== promptLine) {
    return text;
  }

  return cut < 0 ? '' : text.slice(0, cut);
}

function stripEcho(text: string, command: string, previousPrompt: string, promptLine: string): string {
  if (!command) {
    return text;
  }

  const needles = echoNeedles(command, previousPrompt, promptLine);

  for (const needle of needles) {
    const end = matchWrapped(text, needle);

    if (end !== null) {
      return text.slice(end);
    }
  }

  return text;
}

function echoNeedles(command: string, previousPrompt: string, promptLine: string): string[] {
  const needles: string[] = [];
  const push = (prefix: string): void => {
    if (!prefix) {
      return;
    }

    const candidate = `${prefix}${command}`;

    if (!needles.includes(candidate)) {
      needles.push(candidate);
    }
  };

  push(previousPrompt);
  push(promptLine);
  push(previousPrompt.trim());
  push(promptLine.trim());
  needles.push(command);

  return needles;
}

/**
 * Match `expected` at the start of `text`, skipping a terminal wrap
 * (`\n` / `\r`, and one space inserted before that wrap). The match must
 * end at the line, so `show` does not consume `show version`.
 */
function matchWrapped(text: string, expected: string): number | null {
  let textIndex = 0;
  let expectedIndex = 0;

  while (expectedIndex < expected.length) {
    if (textIndex >= text.length) {
      return null;
    }

    const current = text[textIndex] ?? '';
    const wanted = expected[expectedIndex] ?? '';

    if (current === wanted) {
      textIndex += current.length;
      expectedIndex += wanted.length;
      continue;
    }

    const next = text[textIndex + 1] ?? '';

    if (current === ' ' && (next === '\n' || next === '\r') && wanted !== ' ') {
      textIndex += 1;
      continue;
    }

    if (current === '\n' || current === '\r') {
      textIndex += 1;
      continue;
    }

    return null;
  }

  const end = text[textIndex] ?? '';

  if (end !== '' && end !== '\n' && end !== '\r') {
    return null;
  }

  if (text[textIndex] === '\r') {
    textIndex += 1;
  }

  if (text[textIndex] === '\n') {
    textIndex += 1;
  }

  return textIndex;
}

function applyCarriageReturns(text: string): string {
  return text.split('\n').map((line) => applyCrLine(line)).join('\n');
}

function applyCrLine(line: string): string {
  let out = '';
  let col = 0;

  for (const ch of line) {
    if (ch === '\r') {
      col = 0;
      continue;
    }

    if (col < out.length) {
      out = out.slice(0, col) + ch + out.slice(col + ch.length);
    } else {
      out += ch;
    }

    col += ch.length;
  }

  return out;
}

function collapseCrLf(text: string): string {
  let out = '';
  let crs = 0;

  for (const ch of text) {
    if (ch === '\r') {
      crs += 1;
      continue;
    }

    if (ch === '\n') {
      out += '\n';
      crs = 0;
      continue;
    }

    if (crs > 0) {
      out += '\r'.repeat(crs);
      crs = 0;
    }

    out += ch;
  }

  if (crs > 0) {
    out += '\r'.repeat(crs);
  }

  return out;
}

export function stripAnsi(text: string): string {
  return stripAnsiChunk(text, { state: 'text' });
}

function stripAnsiChunk(text: string, carry: AnsiCarry): string {
  let out = '';

  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index] ?? '';
    const code = text.charCodeAt(index);

    switch (carry.state) {
      case 'text':
        if (ch === '\u001b') {
          carry.state = 'esc';
        } else {
          out += ch;
        }
        break;
      case 'esc':
        if (ch === '[') {
          carry.state = 'csi';
        } else if (ch === ']') {
          carry.state = 'osc';
        } else if (code >= 0x20 && code <= 0x2f) {
          carry.state = 'esc-int';
        } else if (code >= 0x40 && code <= 0x5f) {
          carry.state = 'text';
        } else {
          carry.state = 'text';
          index -= 1;
        }
        break;
      case 'esc-int':
        if (code >= 0x20 && code <= 0x2f) {
          break;
        }

        if (code >= 0x40 && code <= 0x7e) {
          carry.state = 'text';
          break;
        }

        carry.state = 'text';
        index -= 1;
        break;
      case 'csi':
        if (code >= 0x40 && code <= 0x7e) {
          carry.state = 'text';
        }
        break;
      case 'osc':
        if (ch === '\u0007') {
          carry.state = 'text';
        } else if (ch === '\u001b') {
          carry.state = 'osc-esc';
        }
        break;
      case 'osc-esc':
        carry.state = ch === '\\' ? 'text' : 'osc';
        break;
      default: {
        const unreachable: never = carry.state;

        return unreachable;
      }
    }
  }

  return out;
}
