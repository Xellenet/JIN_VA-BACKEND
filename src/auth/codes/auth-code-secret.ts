import { hkdfSync } from 'node:crypto';

/** Where the code-hashing key came from. Logged once at startup (never the key). */
export type AuthCodeSecretSource =
  | 'AUTH_CODE_SECRET'
  | 'SESSION_COOKIE_SECRET'
  | 'dev-fallback';

export interface AuthCodeKeys {
  /** HMAC key for `code_hash`. */
  codeKey: Buffer;
  /** HMAC key for `email_hash` — a different key, so one hash can't stand in for the other. */
  emailKey: Buffer;
  source: AuthCodeSecretSource;
}

const DEV_FALLBACK = 'dev-only-insecure-auth-code-secret-change-me';

/**
 * The secret behind every code and email hash.
 *
 * `AUTH_CODE_SECRET` when set. Otherwise it is derived from the existing
 * `SESSION_COOKIE_SECRET` (already required in production), so a deployment
 * that hasn't added the new variable keeps working. Outside production, with
 * neither set, an obviously-insecure constant is used, like the session
 * cookie's own fallback. In production with neither, startup fails.
 *
 * The raw secret is never used directly: two sub-keys are derived with
 * HKDF-SHA-256 under distinct labels, so the code key, the email key and the
 * session-cookie key (when shared) are all independent.
 *
 * Rotating the secret invalidates every live code (at most 10 minutes' worth)
 * and resets the send counters; nothing else depends on it.
 */
export function resolveAuthCodeKeys(
  env: NodeJS.ProcessEnv = process.env,
): AuthCodeKeys {
  let secret: string;
  let source: AuthCodeSecretSource;
  if (env.AUTH_CODE_SECRET) {
    secret = env.AUTH_CODE_SECRET;
    source = 'AUTH_CODE_SECRET';
  } else if (env.SESSION_COOKIE_SECRET) {
    secret = env.SESSION_COOKIE_SECRET;
    source = 'SESSION_COOKIE_SECRET';
  } else if (env.NODE_ENV === 'production') {
    throw new Error(
      'AUTH_CODE_SECRET (or SESSION_COOKIE_SECRET) must be set in production',
    );
  } else {
    secret = DEV_FALLBACK;
    source = 'dev-fallback';
  }
  const derive = (label: string) =>
    Buffer.from(hkdfSync('sha256', secret, 'jinva-auth-v2', label, 32));
  return {
    codeKey: derive('auth-code'),
    emailKey: derive('auth-email'),
    source,
  };
}
