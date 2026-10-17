import { describe, expect, it, vi } from 'vitest';
import { READ_COMMAND, runLiveSmoke } from './live-smoke.mjs';

const validEnv = {
  SSH_HOST: 'router.invalid',
  SSH_PORT: '22',
  SSH_USER: 'smoke-user',
  SSH_PASSWORD: 'private-password-marker',
  SSH_HOST_FINGERPRINT: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
};

class FakeSshClientError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

describe('live smoke', () => {
  it('refuses a missing fingerprint even if insecure skip was requested', async () => {
    const log = vi.fn();
    const logError = vi.fn();
    const loadClient = vi.fn();

    const exitCode = await runLiveSmoke({
      env: { ...validEnv, SSH_HOST_FINGERPRINT: '', SSH_INSECURE_SKIP_VERIFY: 'true' },
      loadClient,
      log,
      logError,
    });

    expect(exitCode).toBe(1);
    expect(loadClient).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith('refusing to connect without SSH_HOST_FINGERPRINT');
  });

  it('runs only sys version and prints sanitized result metrics before clean completion', async () => {
    const log = vi.fn();
    const logError = vi.fn();
    const clientOptions = [];
    const commands = [];
    const lifecycle = [];

    class FakeClient {
      constructor(options) {
        clientOptions.push(options);
      }

      async connect() {
        lifecycle.push('connect');
      }

      async exec(command) {
        commands.push(command);
        return {
          stdout: 'private-router-output-marker',
          durationMs: 12,
          connectMs: 4,
        };
      }

      async disconnect() {
        lifecycle.push('disconnect');
      }
    }

    const exitCode = await runLiveSmoke({
      env: validEnv,
      loadClient: async () => ({ SshClient: FakeClient, SshClientError: FakeSshClientError }),
      log,
      logError,
    });

    expect(exitCode).toBe(0);
    expect(READ_COMMAND).toBe('sys version');
    expect(commands).toEqual(['sys version']);
    expect(clientOptions[0]).toEqual({
      host: validEnv.SSH_HOST,
      port: 22,
      username: validEnv.SSH_USER,
      password: validEnv.SSH_PASSWORD,
      hostFingerprint: validEnv.SSH_HOST_FINGERPRINT,
    });
    expect(clientOptions[0]).not.toHaveProperty('insecureSkipVerify');
    expect(lifecycle).toEqual(['connect', 'disconnect']);
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({ stdoutBytes: 28, durationMs: 12, connectMs: 4 }),
    );
    expect(logError).not.toHaveBeenCalled();
    expect(log.mock.calls.join(' ')).not.toContain('private-router-output-marker');
    expect(log.mock.calls.join(' ')).not.toContain(validEnv.SSH_PASSWORD);
  });

  it('reports only hostkey for a mismatched pin and still disconnects', async () => {
    const log = vi.fn();
    const logError = vi.fn();
    const lifecycle = [];

    class FakeClient {
      async connect() {
        lifecycle.push('connect');
        throw new FakeSshClientError('hostkey', 'private-host-and-fingerprint-marker');
      }

      async exec() {
        throw new Error('exec must not run after a connect failure');
      }

      async disconnect() {
        lifecycle.push('disconnect');
      }
    }

    const exitCode = await runLiveSmoke({
      env: validEnv,
      loadClient: async () => ({ SshClient: FakeClient, SshClientError: FakeSshClientError }),
      log,
      logError,
    });

    expect(exitCode).toBe(1);
    expect(lifecycle).toEqual(['connect', 'disconnect']);
    expect(log).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith(JSON.stringify({ errorCode: 'hostkey' }));
    expect(logError.mock.calls.join(' ')).not.toContain('private-host-and-fingerprint-marker');
  });

  it('redacts unexpected errors and disconnect failures', async () => {
    const log = vi.fn();
    const logError = vi.fn();

    class FakeClient {
      async connect() {
        throw new Error('private-connection-details-marker');
      }

      async disconnect() {
        throw new Error('private-disconnect-details-marker');
      }
    }

    const exitCode = await runLiveSmoke({
      env: validEnv,
      loadClient: async () => ({ SshClient: FakeClient, SshClientError: FakeSshClientError }),
      log,
      logError,
    });

    expect(exitCode).toBe(1);
    expect(log).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith(JSON.stringify({ errorCode: 'unexpected' }));
    expect(logError.mock.calls.join(' ')).not.toContain('private-connection-details-marker');
    expect(logError.mock.calls.join(' ')).not.toContain('private-disconnect-details-marker');
  });
});
