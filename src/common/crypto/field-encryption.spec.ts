import { randomBytes } from 'crypto';
import {
  FieldCipher,
  FieldEncryptionError,
  fieldCipherFromConfig,
  parseKey,
} from './field-encryption';

const keyA = randomBytes(32);
const keyB = randomBytes(32);

describe('field encryption (AES-256-GCM)', () => {
  it('round-trips and uses the versioned v1:<keyId>:<iv>:<tag>:<ct> format', () => {
    const cipher = new FieldCipher(keyA);
    const sealed = cipher.encrypt('0240000000');
    const parts = sealed.split(':');
    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe('v1');
    expect(parts[1]).toBe(cipher.keyId);
    expect(parts.slice(2).every((p) => /^[A-Za-z0-9_-]+$/.test(p))).toBe(true);
    expect(Buffer.from(parts[2], 'base64url')).toHaveLength(12);
    expect(Buffer.from(parts[3], 'base64url')).toHaveLength(16);
    expect(sealed).not.toContain('0240000000');
    expect(cipher.decrypt(sealed)).toBe('0240000000');
  });

  it('uses a fresh IV every time', () => {
    const cipher = new FieldCipher(keyA);
    expect(cipher.encrypt('AUTH_x1')).not.toBe(cipher.encrypt('AUTH_x1'));
  });

  it.each([
    ['ciphertext', 4],
    ['tag', 3],
    ['iv', 2],
  ])('detects a tampered %s', (_label, index) => {
    const cipher = new FieldCipher(keyA);
    const parts = cipher.encrypt('AUTH_secretcode').split(':');
    const raw = Buffer.from(parts[index], 'base64url');
    raw[0] ^= 0xff;
    parts[index] = raw.toString('base64url');
    expect(() => cipher.decrypt(parts.join(':'))).toThrow(FieldEncryptionError);
  });

  it('refuses an unknown key id, a malformed value and another version', () => {
    const a = new FieldCipher(keyA);
    const b = new FieldCipher(keyB);
    expect(() => b.decrypt(a.encrypt('x'))).toThrow(/not configured/);
    expect(() => a.decrypt('nope')).toThrow(/format/);
    expect(() => a.decrypt(a.encrypt('x').replace(/^v1/, 'v2'))).toThrow(
      /format/,
    );
    const short = a.encrypt('x').split(':');
    short[2] = Buffer.alloc(4).toString('base64url');
    expect(() => a.decrypt(short.join(':'))).toThrow(/Malformed/);
  });

  it('reads values written with the previous key after rotation; writes with the new one', () => {
    const old = new FieldCipher(keyA);
    const sealedOld = old.encrypt('0550000000');
    const rotated = new FieldCipher(keyB, keyA);
    expect(rotated.decrypt(sealedOld)).toBe('0550000000');
    const sealedNew = rotated.encrypt('0550000000');
    expect(sealedNew.split(':')[1]).toBe(new FieldCipher(keyB).keyId);
    expect(() => old.decrypt(sealedNew)).toThrow(FieldEncryptionError);
  });

  it('keyed hash: stable per key, different across keys, candidates cover rotation', () => {
    const a = new FieldCipher(keyA);
    const b = new FieldCipher(keyB, keyA);
    expect(a.hash('SIG_1')).toBe(a.hash('SIG_1'));
    expect(a.hash('SIG_1')).toMatch(/^[0-9a-f]{64}$/);
    expect(a.hash('SIG_1')).not.toBe(b.hash('SIG_1'));
    expect(b.hashCandidates('SIG_1')).toEqual([
      b.hash('SIG_1'),
      a.hash('SIG_1'),
    ]);
    // The same key given as previous is not listed twice.
    expect(new FieldCipher(keyA, keyA).hashCandidates('x')).toHaveLength(1);
  });

  it('parses standard and url-safe base64 keys of exactly 32 bytes', () => {
    expect(parseKey(keyA.toString('base64'))).toEqual(keyA);
    expect(parseKey(keyA.toString('base64url'))).toEqual(keyA);
    expect(() => parseKey(randomBytes(16).toString('base64'))).toThrow(
      /32 bytes/,
    );
    expect(() => parseKey('not base64!')).toThrow(/base64/);
  });

  it('builds from config: null without a key, throws on a bad one', () => {
    expect(fieldCipherFromConfig(undefined)).toBeNull();
    expect(fieldCipherFromConfig('   ')).toBeNull();
    expect(() => fieldCipherFromConfig('short')).toThrow(FieldEncryptionError);
    const c = fieldCipherFromConfig(
      keyB.toString('base64'),
      keyA.toString('base64'),
    );
    expect(c?.decrypt(new FieldCipher(keyA).encrypt('ok'))).toBe('ok');
    expect(fieldCipherFromConfig(keyB.toString('base64'), '')).not.toBeNull();
  });
});
