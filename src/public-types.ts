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
  /**
   * Optional full-line prompt matcher for hosts whose prompt changes.
   * A match counts only when it covers the entire current line.
   * When omitted, the line captured at the first ready prompt is matched exactly.
   */
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
  /** Epoch ms when the response settled. Failures reject and do not carry this field. */
  recvAt: number;
  /** Ms spent connecting/reconnecting before this command (0 if already up). */
  connectMs: number;
}

export interface ShellPtyOptions {
  term: string;
  rows: number;
  cols: number;
}
