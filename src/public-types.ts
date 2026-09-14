export interface SshClientOptions {
  host: string;
  port?: number;
  username: string;
  password: string;
  hostFingerprint?: string;
  insecureSkipVerify?: boolean;
  readyTimeoutMs?: number;
  commandTimeoutMs?: number;
  maxPages?: number;
  maxOutputBytes?: number;
  settleMs?: number;
  promptRegex?: RegExp;
}

export interface ExecOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  maxPages?: number;
  maxOutputBytes?: number;
}

export interface ExecResult {
  stdout: string;
  durationMs: number;
}
