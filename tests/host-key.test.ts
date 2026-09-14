import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fingerprintSha256, hostKeyMatches, normalize } from '../src/host-key.js';

const hostKey = Buffer.from('test-host-key');
const digestHex = createHash('sha256').update(hostKey).digest('hex');
const digestBase64 = createHash('sha256').update(hostKey).digest('base64');
const unpaddedFingerprint = `SHA256:${digestBase64.replace(/=+$/u, '')}`;

describe('fingerprintSha256', () => {
  it('returns an OpenSSH SHA256 fingerprint without base64 padding', () => {
    expect(fingerprintSha256(hostKey)).toBe(unpaddedFingerprint);
  });
});

describe('normalize', () => {
  it.each([
    ['lowercase SHA256 prefix', `sha256:${digestBase64}`, unpaddedFingerprint],
    ['uppercase SHA256 prefix', `SHA256:${digestBase64}`, unpaddedFingerprint],
    ['64-character hex digest', digestHex, unpaddedFingerprint],
  ])('normalizes %s', (_caseName, input, expected) => {
    expect(normalize(input)).toBe(expected);
  });
});

describe('hostKeyMatches', () => {
  it.each([
    ['SHA256 fingerprint', unpaddedFingerprint],
    ['padded SHA256 fingerprint', `sha256:${digestBase64}`],
    ['hex fingerprint', digestHex],
  ])('matches %s', (_caseName, fingerprint) => {
    expect(hostKeyMatches(fingerprint, hostKey)).toBe(true);
  });

  it.each([
    ['different same-length fingerprint', `SHA256:${'a'.repeat(unpaddedFingerprint.length - 'SHA256:'.length)}`],
    ['different length fingerprint', 'SHA256:short'],
  ])('rejects %s', (_caseName, fingerprint) => {
    expect(hostKeyMatches(fingerprint, hostKey)).toBe(false);
  });
});
