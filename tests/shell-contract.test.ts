import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ShellIo, runCommandOnShell } from '../src/shell-io.js';
import { FakeSsh2Channel } from './support/fake-ssh2.js';

const prompt = 'router# ';

describe('shell contract', () => {
  it('intermediate hash does not settle', async () => {
    const channel = new FakeSsh2Channel({ prompt });
    const io = shell(channel);
    const command = `hash ${randomUUID()}`;
    let settled = false;
    const pending = io
      .runCommand(command, limits())
      .then((value) => {
        settled = true;
        return value;
      });

    channel.emitText(`${command}\r\nconfig value #`);
    await new Promise((resolve) => setTimeout(resolve, 15));

    expect(settled).toBe(false);
    channel.emitText(`\nkept\n${prompt}`);

    await expect(pending).resolves.toBe('config value #\nkept');
    io.detach();
  });

  it('prompt-like body then real prompt', async () => {
    const channel = new FakeSsh2Channel({ prompt });
    const io = shell(channel);
    const command = `body ${randomUUID()}`;
    const pending = io.runCommand(command, limits());

    channel.emitText(`${command}\r\nvalue #\n${prompt}`);

    await expect(pending).resolves.toBe('value #');
    io.detach();
  });

  it('regex metacharacters in identity', async () => {
    const identity = 'a.b# ';
    const channel = new FakeSsh2Channel({ prompt: identity });
    const io = new ShellIo(channel, { promptIdentity: identity, settleMs: 0, idleBufferMaxBytes: 64_000 });
    const command = `dot ${randomUUID()}`;
    let settled = false;
    const pending = io.runCommand(command, limits()).then((value) => {
      settled = true;
      return value;
    });

    channel.emitText(`${command}\r\naxb# `);
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(settled).toBe(false);

    channel.emitText(`\nvalue\n${identity}`);
    await expect(pending).resolves.toContain('value');
    io.detach();
  });

  it('custom regex is full line', async () => {
    const channel = new FakeSsh2Channel({ prompt });
    const io = new ShellIo(channel, {
      promptRegex: /^user@host:\S+\$ $/u,
      settleMs: 0,
      idleBufferMaxBytes: 64_000,
    });
    const command = `rx ${randomUUID()}`;
    let settled = false;
    const pending = io.runCommand(command, limits()).then((value) => {
      settled = true;
      return value;
    });

    channel.emitText(`${command}\r\nuser@host:~$ $ extra\n`);
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(settled).toBe(false);

    channel.emitText(`hello\nuser@host:~$ `);
    await expect(pending).resolves.toBe('user@host:~$ $ extra\nhello');
    io.detach();
  });

  it('prompt split across chunks', async () => {
    const channel = new FakeSsh2Channel({ prompt });
    const io = shell(channel);
    const command = `split ${randomUUID()}`;
    let settled = false;
    const pending = io.runCommand(command, limits()).then((value) => {
      settled = true;
      return value;
    });

    channel.emitText(`${command}\r\nhello\nrouter`);
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(settled).toBe(false);

    channel.emitText('# ');
    await expect(pending).resolves.toBe('hello');
    io.detach();
  });

  it('pager split', async () => {
    const channel = new FakeSsh2Channel({ prompt });
    const io = shell(channel);
    const command = `page ${randomUUID()}`;
    const pending = io.runCommand(command, limits());

    channel.emitText(`${command}\r\n${'x'.repeat(30)}--- MOR`);
    expect(channel.writes).not.toContain(' ');
    channel.emitText('E ---');
    expect(channel.writes).toContain(' ');
    channel.emitText(`\nbar\n${prompt}`);

    expect(channel.writes).toContain(' ');
    await expect(pending).resolves.toContain('bar');
    await expect(pending).resolves.not.toContain('MORE');
    io.detach();
  });

  it('one chunk equals many', async () => {
    const command = `same ${randomUUID()}`;
    const body = '  indented\n\n# comment\n';
    const payload = Buffer.from(`${command}\r\n${body}${prompt}`);
    const once = await collect(command, [payload]);
    const pieces: Buffer[] = [];

    for (let index = 0; index < payload.length; index += 1) {
      pieces.push(payload.subarray(index, index + 1));
    }

    const many = await collect(command, pieces);

    expect(many).toBe(once);
    expect(once).toContain('  indented');
  });

  it('multibyte on the boundary', async () => {
    const channel = new FakeSsh2Channel({ prompt });
    const io = shell(channel);
    const pending = io.runCommand(`edge ${randomUUID()}`, limits(1));

    channel.emitChunk(Buffer.from('à'));

    await expect(pending).rejects.toMatchObject({
      code: 'limit',
      message: 'command output exceeded maxOutputBytes=1',
    });
    io.detach();
  });

  it('overflow rejects and clears', async () => {
    const channel = new FakeSsh2Channel({ prompt });
    const io = shell(channel);
    const first = io.runCommand(`big ${randomUUID()}`, limits(4));

    channel.emitText('12345');
    await expect(first).rejects.toMatchObject({ code: 'limit' });

    const next = `next ${randomUUID()}`;
    const second = io.runCommand(next, limits());

    channel.emitText(`${next}\r\nok\n${prompt}`);
    await expect(second).resolves.toBe('ok');
    io.detach();
  });

  it('echo disabled', async () => {
    const command = `quiet ${randomUUID()}`;
    const channel = new FakeSsh2Channel({
      commands: { [command]: { body: 'value\n', echo: false } },
      prompt,
    });
    const stdout = await runCommandOnShell(channel, command, shellOptions());

    expect(stdout).toBe('value');
  });

  it('listener stability', async () => {
    const channel = new FakeSsh2Channel({ prompt });
    const io = shell(channel);

    expect(channel.listenerCount('data')).toBe(1);

    for (let index = 0; index < 1_000; index += 1) {
      const command = `c${index}`;
      const pending = io.runCommand(command, limits());

      channel.emitText(`${command}\r\nok\n${prompt}`);
      await pending;
    }

    expect(channel.listenerCount('data')).toBe(1);
    io.detach();
    expect(channel.listenerCount('data')).toBe(0);
  });

  it('abort listener removed', async () => {
    const channel = new FakeSsh2Channel({ prompt });
    const io = shell(channel);
    const controller = new AbortController();
    const command = `once ${randomUUID()}`;
    const first = io.runCommand(command, limits(), { signal: controller.signal });

    channel.emitText(`${command}\r\nok\n${prompt}`);
    await first;

    const next = `next ${randomUUID()}`;
    const second = io.runCommand(next, limits());

    controller.abort();
    channel.emitText(`${next}\r\nok\n${prompt}`);
    await expect(second).resolves.toBe('ok');
    io.detach();
  });

  it('abort and timeout same tick', async () => {
    vi.useFakeTimers();

    try {
      const channel = new FakeSsh2Channel({ prompt });
      const io = shell(channel);
      const controller = new AbortController();
      const pending = io.runCommand(`hold ${randomUUID()}`, limits(), {
        signal: controller.signal,
        timeoutMs: 50,
      });
      const assertion = expect(pending).rejects.toMatchObject({ code: expect.stringMatching(/^(timeout|closed)$/u) });

      setTimeout(() => controller.abort(), 50);
      await vi.advanceTimersByTimeAsync(50);
      await assertion;
      io.detach();
    } finally {
      vi.useRealTimers();
    }
  });

  it('close races command timeout', async () => {
    vi.useFakeTimers();

    try {
      const channel = new FakeSsh2Channel({ prompt });
      const io = shell(channel);
      const pending = io.runCommand(`race ${randomUUID()}`, limits(), { timeoutMs: 50 });
      const assertion = expect(pending).rejects.toMatchObject({ code: expect.stringMatching(/^(timeout|closed)$/u) });

      setTimeout(() => channel.close(), 50);
      await vi.advanceTimersByTimeAsync(50);
      await assertion;
      io.detach();
    } finally {
      vi.useRealTimers();
    }
  });

  it('pager write failure settles closed', async () => {
    const channel = new FakeSsh2Channel({ prompt });
    const io = shell(channel);
    const original = channel.write.bind(channel);

    channel.write = (data: string | Buffer) => {
      if (String(data) === ' ') {
        throw new Error('pager write');
      }

      return original(data);
    };

    const pending = io.runCommand(`p ${randomUUID()}`, limits());

    channel.emitText('--- MORE ---');
    await expect(pending).rejects.toMatchObject({ code: 'closed', message: 'pager write' });
    io.detach();
  });
});

function shell(channel: FakeSsh2Channel): ShellIo {
  return new ShellIo(channel, { promptIdentity: prompt, settleMs: 0, idleBufferMaxBytes: 64_000 });
}

function limits(maxOutputBytes = 1_000_000): {
  commandTimeoutMs: number;
  maxPages: number;
  maxOutputBytes: number;
  settleMs: number;
} {
  return { commandTimeoutMs: 500, maxPages: 4, maxOutputBytes, settleMs: 0 };
}

function shellOptions(): Parameters<typeof runCommandOnShell>[2] {
  return {
    ...limits(),
    promptIdentity: prompt,
    idleBufferMaxBytes: 64_000,
  };
}

async function collect(command: string, chunks: Buffer[]): Promise<string> {
  const channel = new FakeSsh2Channel({ prompt });
  const io = shell(channel);
  const pending = io.runCommand(command, limits());

  for (const chunk of chunks) {
    channel.emitChunk(chunk);
  }

  const stdout = await pending;
  io.detach();

  return stdout;
}
