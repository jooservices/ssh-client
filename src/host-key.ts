import { createHash, timingSafeEqual } from 'node:crypto';

export function fingerprintSha256(hostKey: Buffer): string {
  const b64 = createHash('sha256').update(hostKey).digest('base64').replace(/=+$/u, '');

  return `SHA256:${b64}`;
}

export function normalize(expected: string): string {
  const trimmed = expected.trim();

  if (/^sha256:/iu.test(trimmed)) {
    return `SHA256:${trimmed.slice(trimmed.indexOf(':') + 1).replace(/=+$/u, '')}`;
  }

  if (/^[0-9a-f]{64}$/iu.test(trimmed)) {
    return `SHA256:${Buffer.from(trimmed, 'hex').toString('base64').replace(/=+$/u, '')}`;
  }

  return trimmed;
}

export function hostKeyMatches(expectedFingerprint: string, hostKey: Buffer): boolean {
  const expected = Buffer.from(normalize(expectedFingerprint));
  const actual = Buffer.from(normalize(fingerprintSha256(hostKey)));

  if (expected.length !== actual.length) {
    return false;
  }

  return timingSafeEqual(expected, actual);
}
