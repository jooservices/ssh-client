const READY_PROMPT = /[>#\$%]\s*$/u;

/** Ready-only detector. Command completion must not call this. */
export function looksLikeReadyPrompt(line: string): boolean {
  return /\S/u.test(line) && READY_PROMPT.test(line);
}

export function normalizePromptRegex(promptRegex: RegExp): RegExp {
  if (!promptRegex.flags.includes('g')) {
    return promptRegex;
  }

  return new RegExp(promptRegex.source, promptRegex.flags.replaceAll('g', ''));
}

/** True only when the regex matches the entire line. */
export function lineFullyMatches(line: string, promptRegex: RegExp): boolean {
  const regex = normalizePromptRegex(promptRegex);
  regex.lastIndex = 0;
  const match = regex.exec(line);

  return match !== null && match.index === 0 && match[0].length === line.length;
}

export function isPromptLine(
  line: string,
  identity: string | null,
  promptRegex: RegExp | null,
): boolean {
  if (promptRegex) {
    return lineFullyMatches(line, promptRegex);
  }

  return identity !== null && line === identity;
}
