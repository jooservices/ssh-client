export type SshErrorCode = 'connect' | 'auth' | 'timeout' | 'closed' | 'invalid' | 'hostkey' | 'limit';

export class SshClientError extends Error {
  readonly code: SshErrorCode;

  constructor(code: SshErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SshClientError';
    this.code = code;
  }
}

export function messageOf(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }

  if (typeof err === 'string') {
    return err;
  }

  return String(err);
}

export function toSshError(err: unknown, fallback: SshErrorCode): SshClientError {
  if (err instanceof SshClientError) {
    return err;
  }

  return new SshClientError(fallback, messageOf(err), { cause: err });
}
