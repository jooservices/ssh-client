import { createHash, timingSafeEqual } from 'node:crypto';
import { SshClientError } from './errors.js';

const SHA256_BODY = /^[A-Za-z0-9+/]{43}$/u;
const HEX_64 = /^[0-9a-f]{64}$/iu;
const COLON_HEX = /^[0-9a-f]{2}(?::[0-9a-f]{2}){31}$/iu;

export function fingerprintSha256(hostKey: Buffer): string {
  const b64 = createHash('sha256').update(hostKey).digest('base64').replace(/=+$/u, '');

  return `SHA256:${b64}`;
}

export function normalize(expected: string): string {
  const trimmed = expected.trim();

  if (/^sha256:/iu.test(trimmed)) {
    return `SHA256:${trimmed.slice(trimmed.indexOf(':') + 1).replace(/=+$/u, '')}`;
  }

  if (HEX_64.test(trimmed)) {
    return `SHA256:${Buffer.from(trimmed, 'hex').toString('base64').replace(/=+$/u, '')}`;
  }

  if (COLON_HEX.test(trimmed)) {
    return `SHA256:${Buffer.from(trimmed.replace(/:/gu, ''), 'hex').toString('base64').replace(/=+$/u, '')}`;
  }

  return trimmed;
}

/** Accept OpenSSH `SHA256:<43 base64>` or 64 hex digits, optionally colon-separated. */
export function parseFingerprint(input: string): string {
  const trimmed = input.trim();
  const recognized = /^sha256:/iu.test(trimmed) || HEX_64.test(trimmed) || COLON_HEX.test(trimmed);
  const normalized = normalize(trimmed);
  const body = normalized.startsWith('SHA256:') ? normalized.slice('SHA256:'.length) : '';

  if (!recognized || !SHA256_BODY.test(body)) {
    throw new SshClientError('invalid', 'hostFingerprint must be a SHA256 base64 fingerprint or 64 hex digits');
  }

  return `SHA256:${body}`;
}

export function hostKeyMatches(expectedFingerprint: string, hostKey: Buffer): boolean {
  const expected = Buffer.from(normalize(expectedFingerprint));
  const actual = Buffer.from(normalize(fingerprintSha256(hostKey)));

  if (expected.length !== actual.length) {
    return false;
  }

  return timingSafeEqual(expected, actual);
}
