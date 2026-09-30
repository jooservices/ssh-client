const READY_PROMPT = /[>#\$%]\s*$/u;

/** Ready-only detector. Command completion must not call this. */
export function looksLikeReadyPrompt(line: string): boolean {
  return /\S/u.test(line) && READY_PROMPT.test(line);
}

/**
 * Anchor a caller regex to the whole line and drop flags that change where
 * `test` starts. `i` and `u` are kept.
 */
export function compilePromptRegex(promptRegex: RegExp): RegExp {
  const flags = promptRegex.flags.replace(/[gym]/gu, '');

  return new RegExp(`^(?:${promptRegex.source})$`, flags);
}

/** @deprecated Use {@link compilePromptRegex}. Kept so existing imports keep working. */
export function normalizePromptRegex(promptRegex: RegExp): RegExp {
  return compilePromptRegex(promptRegex);
}

/** True only when the regex matches the entire line. */
export function lineFullyMatches(line: string, promptRegex: RegExp): boolean {
  return compilePromptRegex(promptRegex).test(line);
}

export function isPromptLine(
  line: string,
  identity: string | null,
  promptRegex: RegExp | null,
): boolean {
  if (promptRegex) {
    return promptRegex.test(line);
  }

  return identity !== null && line === identity;
}
