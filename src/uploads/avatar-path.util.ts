import { isSafeMediaFilename } from './upload-folders';

/** The only folder whose files `DELETE /users/me/avatar` may remove. */
export const AVATARS_FOLDER = 'avatars';

/** A stored avatar's basename: letters, digits, dot, underscore, hyphen. */
const AVATAR_BASENAME = /^[A-Za-z0-9._-]+$/;

/** Percent-encoded `/`, `\`, `.` and `%` (double encoding). */
const ENCODED_SEPARATOR = /%(2f|5c|2e|25)/i;

/** Normalises a configured base (`https://cdn.example.com/` → `https://cdn.example.com`). */
function normaliseBase(base: string): string | null {
  const trimmed = base.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.search || url.hash || url.username || url.password) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

/**
 * The public bases our own storage writes avatar URLs under, from the same
 * environment variables `S3StorageProvider.buildPublicUrl` uses. Names only
 * are read here; nothing is logged.
 */
export function ownAvatarPublicBases(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const bases: string[] = [];
  const read = (name: string) => {
    const value = env[name];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  };
  const publicBase = read('AWS_S3_PUBLIC_URL_BASE');
  const bucket = read('AWS_S3_BUCKET');
  const region = read('AWS_S3_REGION');
  const endpoint = read('AWS_S3_ENDPOINT');
  if (publicBase) bases.push(publicBase);
  if (endpoint && bucket) {
    bases.push(`${endpoint.replace(/\/+$/, '')}/${bucket}`);
  }
  if (bucket && region) {
    bases.push(`https://${bucket}.s3.${region}.amazonaws.com`);
  }
  return bases
    .map(normaliseBase)
    .filter((base): base is string => base !== null);
}

/**
 * SEC-5 / T-10: the filename to delete for a stored `profilePicture`, or
 * `null` when the value is not one of our own avatar files.
 *
 * Accepted, and nothing else:
 * - `/uploads/avatars/<file>` (local disk, or S3 in proxy delivery);
 * - `<one of our public bases>/avatars/<file>` (S3 direct delivery).
 *
 * Refused: any other host (a Google `lh3.googleusercontent.com` photo, a
 * tracker), `..`, backslashes, percent-encoded separators, query strings or
 * fragments, nested folders, and basenames outside `[A-Za-z0-9._-]`.
 */
export function resolveOwnAvatarFilename(
  stored: string | null | undefined,
  publicBases: string[] = ownAvatarPublicBases(),
): string | null {
  if (typeof stored !== 'string') return null;
  const value = stored.trim();
  if (!value || value.length > 2048) return null;
  if (value.includes('\\') || value.includes('..')) return null;
  if (ENCODED_SEPARATOR.test(value)) return null;
  if (value.includes('?') || value.includes('#')) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\s]/.test(value)) return null;

  let rest: string | null = null;
  const localPrefix = `/uploads/${AVATARS_FOLDER}/`;
  if (value.startsWith(localPrefix)) {
    rest = value.slice(localPrefix.length);
  } else {
    for (const raw of publicBases) {
      const base = normaliseBase(raw);
      if (!base) continue;
      const prefix = `${base}/${AVATARS_FOLDER}/`;
      if (value.startsWith(prefix)) {
        rest = value.slice(prefix.length);
        break;
      }
    }
  }
  if (rest === null) return null;
  if (rest.includes('/')) return null;
  if (!AVATAR_BASENAME.test(rest) || !isSafeMediaFilename(rest)) return null;
  return rest;
}
