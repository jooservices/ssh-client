export type SshErrorCode = 'connect' | 'auth' | 'timeout' | 'closed' | 'invalid';

export class SshClientError extends Error {
  readonly code: SshErrorCode;

  constructor(code: SshErrorCode, message: string) {
    super(message);
    this.name = 'SshClientError';
    this.code = code;
  }
}
