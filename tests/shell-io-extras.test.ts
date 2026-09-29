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

    await expect(run).rejects.toMatchObject({ code: 'timeout', message: /maxPages=0/u });
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

    expect(channel.writes.some((w) => String(w) === '\r' || String(w) === 'q')).toBe(true);

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

  it('swallows resync write failures without rejecting later commands', async () => {
    const channel = new FakeSsh2Channel({ prompt });
    const io = new ShellIo(channel, { promptIdentity: prompt, settleMs: 0, idleBufferMaxBytes: 64_000 });
    const stuck = `stuck-write ${randomUUID()}`;
    const originalWrite = channel.write.bind(channel);
    channel.write = (data: string | Buffer) => {
      const text = String(data);
      if (text === '\r' || text === 'q') {
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

    const next = `after-resync ${randomUUID()}`;
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

    const big = io.runCommand(
      `big ${randomUUID()}`,
      { commandTimeoutMs: 500, maxPages: 2, maxOutputBytes: 8, settleMs: 0 },
    );
    channel.emitText(`${'x'.repeat(64)}\n`);
    await expect(big).rejects.toMatchObject({ code: 'invalid', message: /maxOutputBytes/ });
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

  it('cancels an in-flight resync when the next command starts', async () => {
    const channel = new FakeSsh2Channel({ prompt, ignoreBareCr: true });
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
      await vi.advanceTimersByTimeAsync(0);
      await expect(pending).resolves.toContain(prompt);
      expect(io.capturedPrompt).toBe(prompt);
      await vi.advanceTimersByTimeAsync(500);
      expect(channel.writes).not.toContain('\r');
      io.detach();
    } finally {
      vi.useRealTimers();
    }
  });
});
