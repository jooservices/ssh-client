import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { SshClientError } from '../src/errors.js';
import { ShellIo, waitForPrompt } from '../src/shell-io.js';
import { FakeSsh2Channel } from './support/fake-ssh2.js';

const prompt = 'router# ';

describe('ShellIo extras', () => {
  it('trims the idle buffer between commands', async () => {
    const channel = new FakeSsh2Channel({ prompt });
    const io = new ShellIo(channel, {
      promptIdentity: prompt,
      settleMs: 0,
      idleBufferMaxBytes: 32,
    });

    channel.emitText('x'.repeat(200));
    await new Promise((r) => setTimeout(r, 5));

    const command = `cmd ${randomUUID()}`;
    const body = `ok ${randomUUID()}\n`;
    const run = io.runCommand(command, {
      commandTimeoutMs: 200,
      maxPages: 2,
      maxOutputBytes: 1_000_000,
      settleMs: 0,
    });
    channel.emitText(`${command}\r\n${body}${prompt}`);
    await expect(run).resolves.toContain('ok');
    io.detach();
  });

  it('quits when the next page repeats the same pager marker', async () => {
    const channel = new FakeSsh2Channel({ prompt });
    const original = channel.write.bind(channel);
    channel.write = (data) => {
      const text = String(data);

      if (text === ' ') {
        channel.writes.push(data);
        channel.emitText('\n--- MORE ---');
        return true;
      }

      if (text === 'q') {
        channel.writes.push(data);
        channel.emitText(`\ndone\n${prompt}`);
        return true;
      }

      return original(data);
    };
    const io = new ShellIo(channel, { promptIdentity: prompt, settleMs: 0, idleBufferMaxBytes: 64_000 });
    const run = io.runCommand(`page ${randomUUID()}`, {
      commandTimeoutMs: 500,
      maxPages: 1,
      maxOutputBytes: 1_000_000,
      settleMs: 0,
    });

    channel.emitText('--- MORE ---');
    await expect(run).rejects.toMatchObject({ code: 'limit', message: /maxPages=1/u });
    expect(channel.writes).toEqual(expect.arrayContaining([' ', 'q']));
    io.detach();
  });

  it('sends q when maxPages is exceeded and still drains to the prompt', async () => {
    const channel = new FakeSsh2Channel({ prompt });
    const io = new ShellIo(channel, { promptIdentity: prompt, settleMs: 0, idleBufferMaxBytes: 64_000 });
    const command = `page ${randomUUID()}`;

    const run = io.runCommand(
      command,
      { commandTimeoutMs: 300, maxPages: 0, maxOutputBytes: 1_000_000, settleMs: 0 },
      { maxPages: 0 },
    );
    await new Promise<void>((resolve) => {
      queueMicrotask(() => resolve());
    });
    channel.emitText(`${command}\r\nline\n--- MORE ---`);
    expect(channel.writes).toContain('q');
    channel.emitText(`rest\n${prompt}`);

    await expect(run).rejects.toMatchObject({ code: 'limit', message: /maxPages=0/u });
    io.detach();
  });

  it('resyncs after timeout so a later command can run', async () => {
    const channel = new FakeSsh2Channel({ prompt });
    const io = new ShellIo(channel, { promptIdentity: prompt, settleMs: 0, idleBufferMaxBytes: 64_000 });
    const stuck = `stuck ${randomUUID()}`;

    await expect(
      io.runCommand(stuck, {
        commandTimeoutMs: 20,
        maxPages: 2,
        maxOutputBytes: 1_000_000,
        settleMs: 0,
      }),
    ).rejects.toMatchObject({ code: 'timeout' });

    expect(channel.writes.some((entry) => String(entry) === '\u0003' || String(entry) === 'q')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const next = `next ${randomUUID()}`;
    const run = io.runCommand(next, {
      commandTimeoutMs: 200,
      maxPages: 2,
      maxOutputBytes: 1_000_000,
      settleMs: 0,
    });
    channel.emitText(`${next}\r\nok\n${prompt}`);
    await expect(run).resolves.toContain('ok');
    io.detach();
  });

  it('waitForPrompt readyPoke writes CR when prompt is delayed', async () => {
    const channel = new FakeSsh2Channel({ prompt });
    const pending = waitForPrompt(channel, {
      promptIdentity: prompt,
      settleMs: 0,
      timeoutMs: 300,
      timeoutMessage: 'ready timeout',
      readyPoke: true,
      maxOutputBytes: 1_000_000,
    });

    await new Promise((r) => setTimeout(r, 100));
    expect(channel.writes).toContain('\r');
    channel.emitText(prompt);
    await expect(pending).resolves.toContain('#');
  });

  it('normalizes global prompt regex and cleans MORE banners', async () => {
    const channel = new FakeSsh2Channel({ prompt });
    const io = new ShellIo(channel, {
      promptRegex: /^router# $/gm,
      settleMs: 0,
      idleBufferMaxBytes: 64_000,
    });
    const command = `more ${randomUUID()}`;
    const run = io.runCommand(command, {
      commandTimeoutMs: 200,
      maxPages: 2,
      maxOutputBytes: 1_000_000,
      settleMs: 0,
    });
    channel.emitText(`${command}\r\n--- MORE ---\nline\n${prompt}`);
    await expect(run).resolves.toContain('line');
    io.detach();
  });

  it('rejects when the channel closes mid-command with a string reason', async () => {
    const channel = new FakeSsh2Channel({ prompt });
    const io = new ShellIo(channel, { promptIdentity: prompt, settleMs: 0, idleBufferMaxBytes: 64_000 });
    const command = `die ${randomUUID()}`;
    const run = io.runCommand(command, {
      commandTimeoutMs: 500,
      maxPages: 2,
      maxOutputBytes: 1_000_000,
      settleMs: 0,
    });
    channel.emit('error', 'gone');
    await expect(run).rejects.toMatchObject({ code: 'closed', message: 'gone' });
    io.detach();
  });

  it('rejects when the channel closes mid-command with an Error reason', async () => {
    const channel = new FakeSsh2Channel({ prompt });
    const io = new ShellIo(channel, { promptIdentity: prompt, settleMs: 0, idleBufferMaxBytes: 64_000 });
    const command = `die-err ${randomUUID()}`;
    const run = io.runCommand(command, {
      commandTimeoutMs: 500,
      maxPages: 2,
      maxOutputBytes: 1_000_000,
      settleMs: 0,
    });
    channel.emit('error', new Error('broken pipe'));
    await expect(run).rejects.toMatchObject({ code: 'closed', message: 'broken pipe' });
    io.detach();
  });

  it('kills the session when a resync write fails', async () => {
    const channel = new FakeSsh2Channel({ prompt });
    const io = new ShellIo(channel, { promptIdentity: prompt, settleMs: 0, idleBufferMaxBytes: 64_000 });
    const stuck = `stuck-write ${randomUUID()}`;
    const originalWrite = channel.write.bind(channel);
    channel.write = (data: string | Buffer) => {
      const text = String(data);
      if (text.includes('\u0003')) {
        throw new Error('write failed');
      }
      return originalWrite(data);
    };

    await expect(
      io.runCommand(stuck, {
        commandTimeoutMs: 20,
        maxPages: 2,
        maxOutputBytes: 1_000_000,
        settleMs: 0,
      }),
    ).rejects.toMatchObject({ code: 'timeout' });

    await expect(
      io.runCommand(`after-resync ${randomUUID()}`, {
        commandTimeoutMs: 200,
        maxPages: 2,
        maxOutputBytes: 1_000_000,
        settleMs: 0,
      }),
    ).rejects.toMatchObject({ code: 'closed', message: 'resync failed' });
    io.detach();
  });

  it('fails the waiter when the command write itself throws', async () => {
    const channel = new FakeSsh2Channel({ prompt });
    const io = new ShellIo(channel, { promptIdentity: prompt, settleMs: 0, idleBufferMaxBytes: 64_000 });
    const originalWrite = channel.write.bind(channel);
    channel.write = () => {
      throw new Error('boom');
    };
    await expect(
      io.runCommand(`w ${randomUUID()}`, {
        commandTimeoutMs: 200,
        maxPages: 2,
        maxOutputBytes: 1_000_000,
        settleMs: 0,
      }),
    ).rejects.toMatchObject({ message: 'boom' });

    channel.write = originalWrite;
    const next = `ok ${randomUUID()}`;
    const run = io.runCommand(next, {
      commandTimeoutMs: 200,
      maxPages: 2,
      maxOutputBytes: 1_000_000,
      settleMs: 0,
    });
    channel.emitText(`${next}\r\nok\n${prompt}`);
    await expect(run).resolves.toContain('ok');
    io.detach();
  });

  it('enforces idleTimeoutMs when no output arrives', async () => {
    const channel = new FakeSsh2Channel({ prompt });
    const io = new ShellIo(channel, { promptIdentity: prompt, settleMs: 0, idleBufferMaxBytes: 64_000 });
    await expect(
      io.runCommand(`idle ${randomUUID()}`, {
        commandTimeoutMs: 5_000,
        maxPages: 2,
        maxOutputBytes: 1_000_000,
        settleMs: 0,
      }, { idleTimeoutMs: 30 }),
    ).rejects.toMatchObject({ code: 'timeout', message: /idle timeout/ });
    io.detach();
  });

  it('includes late output chunks that arrive during settleMs', async () => {
    const channel = new FakeSsh2Channel({ prompt });
    const io = new ShellIo(channel, { promptIdentity: prompt, settleMs: 40, idleBufferMaxBytes: 64_000 });
    const command = `late ${randomUUID()}`;
    const run = io.runCommand(command, {
      commandTimeoutMs: 500,
      maxPages: 2,
      maxOutputBytes: 1_000_000,
      settleMs: 40,
    });
    channel.emitText(`${command}\r\nearly\n${prompt}`);
    await new Promise((r) => setTimeout(r, 10));
    channel.emitText(`late-line\n${prompt}`);
    await expect(run).resolves.toContain('late-line');
    io.detach();
  });

  it('rejects when AbortSignal fires and when maxOutputBytes is exceeded', async () => {
    const channel = new FakeSsh2Channel({ prompt });
    const io = new ShellIo(channel, { promptIdentity: prompt, settleMs: 0, idleBufferMaxBytes: 64_000 });
    const ac = new AbortController();
    const aborted = io.runCommand(
      `abort ${randomUUID()}`,
      { commandTimeoutMs: 5_000, maxPages: 2, maxOutputBytes: 1_000_000, settleMs: 0 },
      { signal: ac.signal },
    );
    ac.abort();
    await expect(aborted).rejects.toMatchObject({ code: 'closed', message: /aborted/ });
    await new Promise((resolve) => setTimeout(resolve, 1));

    const big = io.runCommand(
      `big ${randomUUID()}`,
      { commandTimeoutMs: 500, maxPages: 2, maxOutputBytes: 8, settleMs: 0 },
    );
    channel.emitText(`${'x'.repeat(64)}\n`);
    await expect(big).rejects.toMatchObject({ code: 'limit', message: /maxOutputBytes/ });
    io.detach();
  });

  it('does not write a command aborted while resync is still running', async () => {
    const channel = new FakeSsh2Channel({ prompt, ignoreInterrupt: true });
    const io = new ShellIo(channel, { promptIdentity: prompt, settleMs: 0, idleBufferMaxBytes: 64_000 });
    const limits = { commandTimeoutMs: 30, maxPages: 2, maxOutputBytes: 1_000_000, settleMs: 0 };
    const controller = new AbortController();
    const command = `cancelled ${randomUUID()}`;

    await expect(io.runCommand(`stuck ${randomUUID()}`, limits)).rejects.toMatchObject({ code: 'timeout' });

    const run = io.runCommand(command, { ...limits, commandTimeoutMs: 500 }, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    channel.emitText(`\n${prompt}`);

    await expect(run).rejects.toMatchObject({ code: 'closed', message: 'aborted' });
    expect(channel.writes.some((entry) => String(entry).includes(command))).toBe(false);
    io.detach();
  });

  it('rejects a command whose signal is already aborted', async () => {
    const channel = new FakeSsh2Channel({ prompt });
    const io = new ShellIo(channel, { promptIdentity: prompt, settleMs: 0, idleBufferMaxBytes: 64_000 });
    const controller = new AbortController();

    controller.abort();
    await expect(
      io.runCommand(
        `gone ${randomUUID()}`,
        { commandTimeoutMs: 200, maxPages: 2, maxOutputBytes: 1_000_000, settleMs: 0 },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: 'closed', message: 'aborted' });
    expect(io.capturedPrompt).toBe(prompt);
    io.detach();
    io.detach();
  });

  it('rejects ready wait while a command is in flight', async () => {
    const channel = new FakeSsh2Channel({ prompt });
    const io = new ShellIo(channel, { promptIdentity: prompt, settleMs: 0, idleBufferMaxBytes: 64_000 });
    const command = `busy ${randomUUID()}`;
    const pending = io.runCommand(command, {
      commandTimeoutMs: 500,
      maxPages: 2,
      maxOutputBytes: 1_000_000,
      settleMs: 0,
    });

    await expect(
      io.waitForReady({
        settleMs: 0,
        timeoutMs: 500,
        timeoutMessage: 'ready prompt timed out',
        maxOutputBytes: 1_000_000,
      }),
    ).rejects.toMatchObject({ code: 'invalid', message: /another command is in flight/u });
    channel.emitText(`${command}\r\nok\n${prompt}`);
    await expect(pending).resolves.toContain('ok');
    io.detach();
  });

  it('waits for resync before the next command writes', async () => {
    const channel = new FakeSsh2Channel({ prompt });
    const io = new ShellIo(channel, { promptIdentity: prompt, settleMs: 0, idleBufferMaxBytes: 64_000 });
    const stuck = `stuck ${randomUUID()}`;

    await expect(
      io.runCommand(stuck, {
        commandTimeoutMs: 20,
        maxPages: 2,
        maxOutputBytes: 1_000_000,
        settleMs: 0,
      }),
    ).rejects.toMatchObject({ code: 'timeout' });

    await new Promise((resolve) => setTimeout(resolve, 10));

    const next = `next ${randomUUID()}`;
    const run = io.runCommand(next, {
      commandTimeoutMs: 200,
      maxPages: 2,
      maxOutputBytes: 1_000_000,
      settleMs: 0,
    });

    channel.emitText(`${next}\r\nok\n${prompt}`);
    await expect(run).resolves.toContain('ok');
    expect(String(channel.writes.at(-1))).toBe(`${next}\r`);
    io.detach();
  });

  it('rearms the idle timer when another chunk arrives', async () => {
    const channel = new FakeSsh2Channel({ prompt });
    const io = new ShellIo(channel, { promptIdentity: prompt, settleMs: 0, idleBufferMaxBytes: 64_000 });
    const command = `idle-chunk ${randomUUID()}`;
    const pending = io.runCommand(
      command,
      { commandTimeoutMs: 500, maxPages: 2, maxOutputBytes: 1_000_000, settleMs: 0 },
      { idleTimeoutMs: 5_000 },
    );

    channel.emitText('partial');
    channel.emitText(`${command}\r\nok\n${prompt}`);
    await expect(pending).resolves.toContain('ok');
    io.detach();
  });

  it('does not settle when the line changes before settleMs', async () => {
    const channel = new FakeSsh2Channel({ prompt });
    const io = new ShellIo(channel, { promptIdentity: prompt, settleMs: 40, idleBufferMaxBytes: 64_000 });
    const command = `shift ${randomUUID()}`;
    const run = io.runCommand(command, {
      commandTimeoutMs: 500,
      maxPages: 2,
      maxOutputBytes: 1_000_000,
      settleMs: 40,
    });

    channel.emitText(`${command}\r\nvalue\n${prompt}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    channel.emitText('extra');
    await new Promise((resolve) => setTimeout(resolve, 50));
    channel.emitText(`\n${prompt}`);
    await expect(run).resolves.toContain('value');
    io.detach();
  });

  it('maps a thrown string and an SshClientError from write to closed', async () => {
    const channel = new FakeSsh2Channel({ prompt });
    const io = new ShellIo(channel, { promptIdentity: prompt, settleMs: 0, idleBufferMaxBytes: 64_000 });
    const limits = { commandTimeoutMs: 200, maxPages: 2, maxOutputBytes: 1_000_000, settleMs: 0 };

    channel.write = () => {
      throw 'nope';
    };
    await expect(io.runCommand(`str ${randomUUID()}`, limits)).rejects.toMatchObject({
      code: 'closed',
      message: 'nope',
    });

    channel.write = () => {
      throw new SshClientError('closed', 'already');
    };
    await expect(io.runCommand(`typed ${randomUUID()}`, limits)).rejects.toMatchObject({
      code: 'closed',
      message: 'already',
    });
    io.detach();
  });

  it('sends kill-line when resync stops on text that is not the prompt', async () => {
    const channel = new FakeSsh2Channel({ prompt, ignoreInterrupt: true });
    const io = new ShellIo(channel, { promptIdentity: prompt, settleMs: 0, idleBufferMaxBytes: 64_000 });
    const limits = { commandTimeoutMs: 200, maxPages: 2, maxOutputBytes: 1_000_000, settleMs: 0 };

    await expect(
      io.runCommand(`stuck ${randomUUID()}`, { ...limits, commandTimeoutMs: 20 }),
    ).rejects.toMatchObject({ code: 'timeout' });
    channel.emitText('partial');
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(channel.writes.some((entry) => String(entry).includes('\u0015'))).toBe(true);

    const next = `next ${randomUUID()}`;
    const run = io.runCommand(next, limits);
    channel.emitText(`${next}\r\nok\n${prompt}`);
    await expect(run).resolves.toContain('ok');
    io.detach();
  });

  it('interrupts when quitting a pager fails before the resync budget ends', async () => {
    const channel = new FakeSsh2Channel({ prompt });
    const original = channel.write.bind(channel);
    channel.write = (data) => {
      if (data === 'q') {
        throw new Error('pager quit failed');
      }

      return original(data);
    };
    const io = new ShellIo(channel, { promptIdentity: prompt, settleMs: 0, idleBufferMaxBytes: 64_000 });
    const run = io.runCommand(`page ${randomUUID()}`, {
      commandTimeoutMs: 40,
      maxPages: 4,
      maxOutputBytes: 1_000_000,
      settleMs: 0,
    });

    channel.emitText('--- MORE ---');
    await expect(run).rejects.toMatchObject({ code: 'timeout' });
    expect(channel.writes.some((entry) => String(entry).includes('\u0003'))).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 5));

    const next = `next ${randomUUID()}`;
    const again = io.runCommand(next, {
      commandTimeoutMs: 200,
      maxPages: 2,
      maxOutputBytes: 1_000_000,
      settleMs: 0,
    });
    channel.emitText(`${next}\r\nok\n${prompt}`);
    await expect(again).resolves.toContain('ok');
    io.detach();
  });

  it('applies the caller output cap while resync is still reading', async () => {
    const channel = new FakeSsh2Channel({ prompt, ignoreInterrupt: true });
    const io = new ShellIo(channel, { promptIdentity: prompt, settleMs: 0, idleBufferMaxBytes: 64_000 });

    await expect(
      io.runCommand(`cap ${randomUUID()}`, {
        commandTimeoutMs: 20,
        maxPages: 2,
        maxOutputBytes: 32,
        settleMs: 0,
      }),
    ).rejects.toMatchObject({ code: 'timeout' });
    channel.emitText('x'.repeat(64));
    await new Promise((resolve) => setTimeout(resolve, 5));

    await expect(
      io.runCommand(`next ${randomUUID()}`, {
        commandTimeoutMs: 200,
        maxPages: 2,
        maxOutputBytes: 1_000_000,
        settleMs: 0,
      }),
    ).rejects.toMatchObject({ code: 'closed', message: 'resync failed' });
    io.detach();
  });

  it('rejects the waiting command when resync fails after it has started waiting', async () => {
    const channel = new FakeSsh2Channel({ prompt, ignoreInterrupt: true });
    const io = new ShellIo(channel, { promptIdentity: prompt, settleMs: 0, idleBufferMaxBytes: 64_000 });
    const limits = { commandTimeoutMs: 200, maxPages: 2, maxOutputBytes: 1_000_000, settleMs: 0 };

    await expect(
      io.runCommand(`stuck ${randomUUID()}`, { ...limits, commandTimeoutMs: 15 }),
    ).rejects.toMatchObject({ code: 'timeout' });

    const next = io.runCommand(`next ${randomUUID()}`, limits);
    channel.emit('close');

    await expect(next).rejects.toMatchObject({ code: 'closed', message: 'resync failed' });
    io.detach();
  });

  it('maps an empty or non-error channel failure to closed', async () => {
    const channel = new FakeSsh2Channel({ prompt });
    const io = new ShellIo(channel, { promptIdentity: prompt, settleMs: 0, idleBufferMaxBytes: 64_000 });
    const limits = { commandTimeoutMs: 200, maxPages: 2, maxOutputBytes: 1_000_000, settleMs: 0 };
    const empty = io.runCommand(`empty ${randomUUID()}`, limits);

    channel.emit('error', new Error(''));
    await expect(empty).rejects.toMatchObject({ code: 'closed', message: 'channel closed' });

    const numbered = io.runCommand(`num ${randomUUID()}`, limits);
    channel.emit('error', 0);
    await expect(numbered).rejects.toMatchObject({ code: 'closed', message: '0' });
    io.detach();
  });

  it('still times out ready when the confirmation write throws', async () => {
    const channel = new FakeSsh2Channel({ prompt });
    const original = channel.write.bind(channel);
    channel.write = (data) => {
      if (data === '\r') {
        throw new Error('no cr');
      }

      return original(data);
    };
    const io = new ShellIo(channel, { promptIdentity: prompt, settleMs: 0, idleBufferMaxBytes: 64_000 });
    const pending = io.waitForReady({
      settleMs: 0,
      timeoutMs: 30,
      timeoutMessage: 'ready prompt timed out',
      maxOutputBytes: 1_000_000,
    });

    channel.emitText(prompt);
    await expect(pending).rejects.toMatchObject({ code: 'timeout' });
    io.detach();
  });

  it('closes the command when a pager write throws', async () => {
    const channel = new FakeSsh2Channel({ prompt });
    const original = channel.write.bind(channel);
    channel.write = (data) => {
      if (data === ' ') {
        throw new Error('no page');
      }

      return original(data);
    };
    const io = new ShellIo(channel, { promptIdentity: prompt, settleMs: 0, idleBufferMaxBytes: 64_000 });
    const run = io.runCommand(`page ${randomUUID()}`, {
      commandTimeoutMs: 200,
      maxPages: 4,
      maxOutputBytes: 1_000_000,
      settleMs: 0,
    });

    channel.emitText('--- MORE ---');
    await expect(run).rejects.toMatchObject({ code: 'closed', message: 'no page' });
    io.detach();
  });

  it('ready poke does not write after the prompt already settled', async () => {
    vi.useFakeTimers();

    try {
      const channel = new FakeSsh2Channel({ prompt });
      const io = new ShellIo(channel, { promptIdentity: prompt, settleMs: 0, idleBufferMaxBytes: 64_000 });
      const pending = io.waitForReady({
        settleMs: 0,
        timeoutMs: 4_000,
        timeoutMessage: 'ready prompt timed out',
        readyPoke: true,
        maxOutputBytes: 1_000_000,
      });

      channel.emitText(prompt);
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toContain(prompt);
      expect(io.capturedPrompt).toBe(prompt);
      expect(channel.writes.filter((entry) => entry === '\r')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(500);
      expect(channel.writes.filter((entry) => entry === '\r')).toHaveLength(1);
      io.detach();
    } finally {
      vi.useRealTimers();
    }
  });
});
