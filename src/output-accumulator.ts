import { StringDecoder } from 'node:string_decoder';

/**
 * Incremental UTF-8 decoder and bounded text buffer.
 * `push` does not join the stored parts. Call `snapshot` once at settlement.
 */
export class OutputAccumulator {
  private parts: string[] = [];
  private tail = '';
  private pendingCr = false;
  private decoder = new StringDecoder('utf8');
  byteLength = 0;

  push(chunk: Buffer): string {
    this.byteLength += chunk.length;
    let text = this.decoder.write(chunk);

    if (this.pendingCr) {
      text = `\r${text}`;
      this.pendingCr = false;
    }

    if (text.endsWith('\r')) {
      this.pendingCr = true;
      text = text.slice(0, -1);
    }

    text = normalizeNewlines(text);
    this.append(text);

    return text;
  }

  snapshot(): string {
    this.flushDecoder();

    return this.parts.join('');
  }

  clear(): void {
    this.parts = [];
    this.tail = '';
    this.pendingCr = false;
    this.byteLength = 0;
    this.decoder = new StringDecoder('utf8');
  }

  currentLine(): string {
    return this.tail;
  }

  trimToMaxBytes(maxBytes: number): void {
    if (this.byteLength <= maxBytes) {
      return;
    }

    let text = this.snapshot();
    this.clear();

    while (Buffer.byteLength(text) > maxBytes && text.length > 0) {
      text = text.slice(Math.ceil(text.length / 2));
    }

    if (text.length > 0) {
      this.push(Buffer.from(text));
    }
  }

  private flushDecoder(): void {
    let text = this.decoder.end();
    this.decoder = new StringDecoder('utf8');

    if (this.pendingCr) {
      text = `\r${text}`;
      this.pendingCr = false;
    }

    this.append(normalizeNewlines(text));
  }

  private append(text: string): void {
    if (text.length === 0) {
      return;
    }

    this.parts.push(text);
    const pieces = text.split('\n');
    this.tail += pieces[0] ?? '';

    for (let index = 1; index < pieces.length; index += 1) {
      this.tail = pieces[index] ?? '';
    }
  }
}

export function cleanOutput(raw: string, command: string, promptLine: string): string {
  let text = normalizeNewlines(raw).replace(/---\s*MORE\s*---/giu, '');

  if (promptLine.length > 0) {
    if (text === promptLine) {
      text = '';
    } else if (text.endsWith(`\n${promptLine}`)) {
      text = text.slice(0, -(promptLine.length + 1));
    }
  }

  if (!command) {
    return text;
  }

  const newlineAt = text.indexOf('\n');
  const first = newlineAt === -1 ? text : text.slice(0, newlineAt);
  const rest = newlineAt === -1 ? '' : text.slice(newlineAt + 1);

  if (!isEchoLine(first, command, promptLine)) {
    return text;
  }

  return rest;
}

function isEchoLine(line: string, command: string, promptLine: string): boolean {
  if (line === command) {
    return true;
  }

  if (!line.endsWith(command)) {
    return false;
  }

  const prefix = line.slice(0, line.length - command.length);

  return prefix === promptLine || prefix.trim() === promptLine.trim();
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n');
}
