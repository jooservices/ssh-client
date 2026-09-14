import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { cleanOutput, runCommandOnShell } from '../src/shell-io.js';
import { FakeSsh2Channel } from './support/fake-ssh2.js';

const prompt = 'router# ';
const promptRegex = /(?:>|#)\s*$/m;

describe('runCommandOnShell', () => {
  it('writes a CR-terminated command and resolves clean stdout after the prompt settles', async () => {
    const command = `show version ${randomUUID()}`;
    const body = `Firmware ${randomUUID()}\r\nUptime ${randomUUID()}\r\n`;
    const channel = new FakeSsh2Channel({ commands: { [command]: { body } }, prompt });

    const stdout = await runCommandOnShell(channel, command, options());

    expect(channel.writes[0]).toBe(`${command}\r`);
    expect(stdout).toBe(body.replace(/\r\n/g, '\n').trim());
  });

  it('advances pager markers without retaining the marker in stdout', async () => {
    const command = `show log ${randomUUID()}`;
    const first = `first page ${randomUUID()}\r\n--- MORE ---`;
    const second = `second page ${randomUUID()}\r\n`;
    const channel = new FakeSsh2Channel({ commands: { [command]: { chunks: [first, second] } }, prompt });

    const stdout = await runCommandOnShell(channel, command, options());

    expect(channel.writes).toContain(' ');
    expect(stdout).toContain(first.replace(/\r\n--- MORE ---/u, ''));
    expect(stdout).toContain(second.trim());
    expect(stdout).not.toContain('MORE');
  });

  it('rejects timeout when a command never reaches the prompt', async () => {
    const command = `slow command ${randomUUID()}`;
    const channel = new FakeSsh2Channel({ commands: { [command]: { chunks: ['still running\n'], prompt: '' } }, prompt });
    const removeListener = vi.spyOn(channel, 'removeListener');

    await expect(runCommandOnShell(channel, command, options({ commandTimeoutMs: 10 }))).rejects.toMatchObject({
      code: 'timeout',
    });
    expect(removeListener).toHaveBeenCalledWith('data', expect.any(Function));
    expect(channel.listenerCount('data')).toBe(0);
  });

  it('rejects closed when aborted before the prompt arrives', async () => {
    const command = `abort command ${randomUUID()}`;
    const controller = new AbortController();
    const channel = new FakeSsh2Channel({
      commands: { [command]: { body: `late ${randomUUID()}\n`, delayMs: 30 } },
      prompt,
    });

    const result = runCommandOnShell(channel, command, options({ commandTimeoutMs: 100 }), { signal: controller.signal });
    controller.abort();

    await expect(result).rejects.toMatchObject({ code: 'closed', message: 'aborted' });
    expect(channel.listenerCount('data')).toBe(0);
  });

  it('rejects closed when the stream closes before the prompt arrives', async () => {
    const command = `closed command ${randomUUID()}`;
    const channel = new FakeSsh2Channel({
      commands: { [command]: { body: `partial ${randomUUID()}\n`, channelEvent: 'close' } },
      prompt,
    });

    await expect(runCommandOnShell(channel, command, options({ commandTimeoutMs: 100 }))).rejects.toMatchObject({
      code: 'closed',
      message: 'channel closed',
    });
    expect(channel.listenerCount('data')).toBe(0);
  });

  it('rejects invalid and removes the data listener when output exceeds maxOutputBytes before the prompt', async () => {
    const command = `large output ${randomUUID()}`;
    const channel = new FakeSsh2Channel({ commands: { [command]: { body: '1234567890\n' } }, prompt });
    const removeListener = vi.spyOn(channel, 'removeListener');

    await expect(runCommandOnShell(channel, command, options({ maxOutputBytes: 8 }))).rejects.toMatchObject({
      code: 'invalid',
      message: 'command output exceeded maxOutputBytes=8',
    });
    expect(removeListener).toHaveBeenCalledWith('data', expect.any(Function));
    expect(channel.listenerCount('data')).toBe(0);
  });

  it('lets per-exec maxPages override the session default', async () => {
    const command = `paged override ${randomUUID()}`;
    const channel = new FakeSsh2Channel({ commands: { [command]: { chunks: ['first\n--- MORE ---', 'second\n'] } }, prompt });

    const stdout = await runCommandOnShell(channel, command, options({ maxPages: 0 }), { maxPages: 1 });

    expect(stdout).toContain('first');
    expect(stdout).toContain('second');
  });

  it('waits for the tail prompt when command output contains a prompt-like body line', async () => {
    const command = `tail prompt ${randomUUID()}`;
    const finalValue = `final ${randomUUID()}`;
    const channel = new FakeSsh2Channel({ prompt });
    let settled = false;

    const stdout = runCommandOnShell(channel, command, options({ commandTimeoutMs: 100 })).then((value) => {
      settled = true;

      return value;
    });

    channel.emitText(`${command}\r\nconfig value #\r\n`);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(settled).toBe(false);

    channel.emitText(`${finalValue}\r\n${prompt}`);

    await expect(stdout).resolves.toBe(`config value #\n${finalValue}`);
  });
});

describe('cleanOutput', () => {
  it('uses a global echo-strip regex so repeated echoed commands are removed', () => {
    const command = `repeat ${randomUUID()}`;
    const raw = `${command}\r\nvalue one\r\n${command}\r\nvalue two\r\n${prompt}`;

    expect(cleanOutput(raw, command, promptRegex)).toBe('value one\nvalue two');
  });
});

function options(overrides: Partial<Parameters<typeof runCommandOnShell>[2]> = {}): Parameters<typeof runCommandOnShell>[2] {
  return {
    commandTimeoutMs: 500,
    maxPages: 4,
    maxOutputBytes: 8_388_608,
    promptRegex,
    settleMs: 0,
    idleBufferMaxBytes: 64 * 1024,
    ...overrides,
  };
}
