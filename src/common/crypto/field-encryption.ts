import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
} from 'crypto';

/**
 * Field-level encryption for payment data at rest (saved mobile money
 * numbers and card authorization codes).
 *
 * - AES-256-GCM, a fresh random 12-byte IV per value, 16-byte auth tag.
 * - Stored as `v1:<keyId>:<iv>:<tag>:<ciphertext>`, every part base64url.
 *   `keyId` is derived from the key itself (first 8 hex chars of
 *   SHA-256 over a label and the key), so no separate id has to be configured
 *   and a rotated key is recognised on read.
 * - Rotation: values written with the previous key still decrypt while that
 *   key is configured as the previous one; new values always use the current
 *   key.
 * - `hash()` is a keyed hash (HMAC-SHA-256 under a sub-key derived with HKDF)
 *   for de-duplication without storing the plaintext (a card's signature).
 *
 * Nothing here logs, and no error message carries a plaintext or a key.
 */

export const FIELD_ENCRYPTION_VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export class FieldEncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FieldEncryptionError';
  }
}

interface KeyMaterial {
  id: string;
  encKey: Buffer;
  hashKey: Buffer;
}

const b64u = (buf: Buffer): string => buf.toString('base64url');
const fromB64u = (s: string): Buffer => Buffer.from(s, 'base64url');

/**
 * Parses a configured key: 32 bytes, base64 (standard or url-safe).
 * Throws `FieldEncryptionError` (without echoing the value) when it is not.
 */
export function parseKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(trimmed)) {
    throw new FieldEncryptionError('The key is not valid base64.');
  }
  const key = Buffer.from(
    trimmed.replace(/-/g, '+').replace(/_/g, '/'),
    'base64',
  );
  if (key.length !== KEY_BYTES) {
    throw new FieldEncryptionError(
      `The key must decode to ${KEY_BYTES} bytes (got ${key.length}).`,
    );
  }
  return key;
}

function material(key: Buffer): KeyMaterial {
  const id = createHash('sha256')
    .update('jinva-field-key-id')
    .update(key)
    .digest('hex')
    .slice(0, 8);
  const derive = (info: string) =>
    Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), info, KEY_BYTES));
  return {
    id,
    encKey: derive('jinva-field-encryption'),
    hashKey: derive('jinva-field-hash'),
  };
}

export class FieldCipher {
  private readonly current: KeyMaterial;
  private readonly byId = new Map<string, KeyMaterial>();

  constructor(currentKey: Buffer, previousKey?: Buffer | null) {
    this.current = material(currentKey);
    this.byId.set(this.current.id, this.current);
    if (previousKey) {
      const previous = material(previousKey);
      if (!this.byId.has(previous.id)) this.byId.set(previous.id, previous);
    }
  }

  get keyId(): string {
    return this.current.id;
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.current.encKey, iv, {
      authTagLength: TAG_BYTES,
    });
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return [
      FIELD_ENCRYPTION_VERSION,
      this.current.id,
      b64u(iv),
      b64u(tag),
      b64u(ciphertext),
    ].join(':');
  }

  decrypt(payload: string): string {
    const parts = typeof payload === 'string' ? payload.split(':') : [];
    if (parts.length !== 5 || parts[0] !== FIELD_ENCRYPTION_VERSION) {
      throw new FieldEncryptionError('Unrecognised encrypted value format.');
    }
    const [, keyId, ivPart, tagPart, dataPart] = parts;
    const key = this.byId.get(keyId);
    if (!key) {
      throw new FieldEncryptionError(
        'The value was encrypted with a key that is not configured.',
      );
    }
    const iv = fromB64u(ivPart);
    const tag = fromB64u(tagPart);
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      throw new FieldEncryptionError('Malformed encrypted value.');
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', key.encKey, iv, {
        authTagLength: TAG_BYTES,
      });
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(fromB64u(dataPart)),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new FieldEncryptionError(
        'The encrypted value failed its integrity check.',
      );
    }
  }

  /** Keyed hash under the current key, hex. */
  hash(value: string): string {
    return createHmac('sha256', this.current.hashKey)
      .update(value)
      .digest('hex');
  }

  /** The hash under every configured key (current first), for look-ups during rotation. */
  hashCandidates(value: string): string[] {
    return [...this.byId.values()].map((k) =>
      createHmac('sha256', k.hashKey).update(value).digest('hex'),
    );
  }
}

/**
 * Builds a cipher from configuration values. `null` when no current key is
 * set; throws `FieldEncryptionError` when a key is set but malformed.
 */
export function fieldCipherFromConfig(
  currentRaw: string | null | undefined,
  previousRaw?: string | null,
): FieldCipher | null {
  if (!currentRaw || !currentRaw.trim()) return null;
  const current = parseKey(currentRaw);
  const previous =
    previousRaw && previousRaw.trim() ? parseKey(previousRaw) : null;
  return new FieldCipher(current, previous);
}
