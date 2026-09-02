/**
 * The sensitivity split of the upload namespace, and the single place that
 * decides which folders may ever be delivered from an anonymously-readable URL.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * `S3StorageProvider.buildPublicUrl` used to return the same public
 * bucket/CDN URL shape for *every* `UploadFolder`, and that union includes
 * `documents` and `selfies` — national-ID front/back scans and KYC selfies.
 * The admin verification screen rendered those stored URLs directly as `<img>`
 * tiles, which carry no `Authorization` header, so the objects had to be
 * anonymously readable for the feature to work at all. Flipping
 * `STORAGE_PROVIDER=s3` would therefore have published identity documents to a
 * public CDN prefix, protected only by UUID obscurity, with no expiry, no
 * revocation and no access trail. The local-disk path had the same shape: the
 * legacy `/uploads` static mount served the whole tree, `documents/` and
 * `selfies/` included.
 *
 * ── The split ───────────────────────────────────────────────────────────────
 * - {@link PUBLIC_UPLOAD_FOLDERS} keep exactly the behaviour they have today:
 *   a public CDN URL under S3, and the long-lived immutable static mount under
 *   local storage. Nothing about avatars, portfolio items, review photos,
 *   message attachments or job attachments changes.
 * - {@link PRIVATE_UPLOAD_FOLDERS} are never reachable anonymously in either
 *   mode:
 *   - under S3 the object key is prefixed with {@link PRIVATE_S3_KEY_PREFIX},
 *     a prefix `AWS_S3_PUBLIC_URL_BASE` must not front, and the provider
 *     returns a non-fetchable reference instead of a CDN URL, so no public URL
 *     for a KYC object is ever minted or persisted;
 *   - under local storage the folder is simply not mounted by
 *     `applyLegacyMediaServing`, so `/uploads/documents/...` falls through to
 *     Nest's clean JSON 404.
 *   Both are then read back through one authenticated, admin-only endpoint
 *   (`GET /uploads/kyc/:folder/:filename`) that streams the bytes with
 *   `Cache-Control: private, no-store`.
 *
 * The prefix is *not* the security control — the access rules are. It exists
 * so that a bucket policy or CDN behaviour can be written against a stable
 * path, and so that a misconfigured public bucket cannot expose KYC objects
 * through the same URL shape the frontend already knows.
 */

export const PUBLIC_UPLOAD_FOLDERS = [
  'avatars',
  'portfolio',
  'reviews',
  /** MC4: image attachments on direct messages. */
  'messages',
  'job-attachments',
] as const;

/** KYC media: identity documents and verification selfies. */
export const PRIVATE_UPLOAD_FOLDERS = ['documents', 'selfies'] as const;

export type PublicUploadFolder = (typeof PUBLIC_UPLOAD_FOLDERS)[number];
export type PrivateUploadFolder = (typeof PRIVATE_UPLOAD_FOLDERS)[number];
export type UploadFolder = PublicUploadFolder | PrivateUploadFolder;

/**
 * S3 key prefix for the private folders. Deliberately a path segment the
 * public CDN URL shape never produces, so an object under it cannot be reached
 * by guessing at `AWS_S3_PUBLIC_URL_BASE/<folder>/<uuid>`.
 */
export const PRIVATE_S3_KEY_PREFIX = 'private';

/**
 * Route (below the `api/v1` global prefix) of the authenticated, admin-only
 * endpoint that reads a private object back. Exported so the providers'
 * documentation and the contract cannot drift apart.
 */
export const KYC_MEDIA_ROUTE = 'uploads/kyc';

export function isPrivateUploadFolder(
  value: string,
): value is PrivateUploadFolder {
  return (PRIVATE_UPLOAD_FOLDERS as readonly string[]).includes(value);
}

export function isPublicUploadFolder(
  value: string,
): value is PublicUploadFolder {
  return (PUBLIC_UPLOAD_FOLDERS as readonly string[]).includes(value);
}

/**
 * The S3 object key for a stored file. Private folders get the private prefix;
 * public folders keep the exact key they have always had, so no existing
 * object or stored URL is invalidated.
 */
export function buildS3ObjectKey(
  folder: UploadFolder,
  filename: string,
): string {
  return isPrivateUploadFolder(folder)
    ? `${PRIVATE_S3_KEY_PREFIX}/${folder}/${filename}`
    : `${folder}/${filename}`;
}

/**
 * What a private upload returns and what gets persisted on the verification
 * row. Deliberately the *same* `/uploads/<folder>/<filename>` shape the local
 * provider has always written, for two reasons: it keeps
 * `POST /uploads/document` and `POST /uploads/selfie` response-compatible, and
 * it means pre-existing rows and new S3-era rows are read back through the one
 * identical rule (`GET /uploads/kyc/<folder>/<filename>`). It is a *reference*,
 * not a URL — nothing serves it, in either storage mode.
 */
export function buildPrivateMediaReference(
  folder: PrivateUploadFolder,
  filename: string,
): string {
  return `/uploads/${folder}/${filename}`;
}

/**
 * Stored filenames are `<uuid><ext>`. This is a belt-and-braces check on the
 * path segment before it is joined onto a disk path or an S3 key: no slash, no
 * backslash, no `..`, no leading dot. Traversal is already blocked downstream
 * (`send` for the static mount, `basename` in the local provider), but a
 * filename arriving from a URL parameter is validated here first so an invalid
 * one is a 400 rather than a probe of the filesystem.
 */
export function isSafeMediaFilename(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && !value.includes('..');
}
