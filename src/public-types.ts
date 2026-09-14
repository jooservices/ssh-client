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
  /** PTY term type for interactive shell (default `vt100`). */
  term?: string;
  /** PTY rows (default `200`). */
  rows?: number;
  /** PTY cols (default `200`). */
  cols?: number;
  /** Cap for unsolicited data between commands (default 64 KiB). */
  idleBufferMaxBytes?: number;
}

export interface ExecOptions {
  timeoutMs?: number;
  /** Fail if no new output arrives for this many ms during a command. */
  idleTimeoutMs?: number;
  signal?: AbortSignal;
  maxPages?: number;
  maxOutputBytes?: number;
}

export interface ExecResult {
  stdout: string;
  /** Wall time from command write to settle (ms). */
  durationMs: number;
  /** Epoch ms when the command was written to the shell. */
  sendAt: number;
  /** Epoch ms when the response settled (or the attempt failed). */
  recvAt: number;
  /** Ms spent connecting/reconnecting before this command (0 if already up). */
  connectMs: number;
}

export interface ShellPtyOptions {
  term: string;
  rows: number;
  cols: number;
}
