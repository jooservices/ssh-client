import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SshClientError } from '../src/errors.js';
import { fingerprintSha256, hostKeyMatches, normalize, parseFingerprint } from '../src/host-key.js';

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
    ['opaque non-sha256 fingerprint', '  md5:legacy  ', 'md5:legacy'],
  ])('normalizes %s', (_caseName, input, expected) => {
    expect(normalize(input)).toBe(expected);
  });
});

describe('parseFingerprint', () => {
  it('accepts SHA256 base64, hex, and colon-hex', () => {
    expect(parseFingerprint(`  sha256:${digestBase64}  `)).toBe(unpaddedFingerprint);
    expect(parseFingerprint(digestHex)).toBe(unpaddedFingerprint);
    const colon = digestHex.replace(/(.{2})(?!$)/gu, '$1:');
    expect(parseFingerprint(colon)).toBe(unpaddedFingerprint);
  });

  it('rejects MD5, empty, and the wrong length', () => {
    expect(() => parseFingerprint('md5:legacy')).toThrow(SshClientError);
    expect(() => parseFingerprint('')).toThrow(/SHA256 base64 fingerprint or 64 hex digits/u);
    expect(() => parseFingerprint('SHA256:abc123')).toThrow(/SHA256 base64 fingerprint or 64 hex digits/u);
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
