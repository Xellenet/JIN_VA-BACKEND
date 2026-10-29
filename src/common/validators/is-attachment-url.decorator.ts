import { registerDecorator, ValidationOptions } from 'class-validator';
import type { UploadFolder } from '../../uploads/providers/storage-provider.interface';

/**
 * Validates that a client-supplied attachment URL is one the platform's own
 * upload endpoints could actually have returned — and, crucially, that it came
 * from the *right* upload endpoint for the field it is attached to.
 *
 * History (each round tightened a real gap found in review):
 *  - Round 1: `attachmentUrls` accepted any string with no validation at all,
 *    so a customer could reference an arbitrary external URL (security, Low,
 *    CWE-20).
 *  - Round 2: the `http(s)` branch accepted *any* well-formed host, so
 *    `https://evil.example/x.jpg` still validated. Narrowed to the configured
 *    S3 public host.
 *  - Round 3 (QA `qa-report.md` B2, major; security `security-report.md` B6):
 *    the local branch was a bare `value.startsWith('/uploads/')`, so any path
 *    anywhere under the uploads tree passed — `/uploads/documents/…` (KYC
 *    material), `/uploads/profiles/…`, `../` and `%2e%2e` traversal strings,
 *    a query string, or a file that never existed. Those values were persisted
 *    and rendered, including inside the admin dispute-evidence viewer, which
 *    contradicted `api-contract.md` §3's "arbitrary URLs are rejected".
 *
 * The validator now pins the value to the *exact* shape the storage providers
 * emit for the caller's own folder(s):
 *
 *  - {@link LocalStorageProvider} (the only active provider — `STORAGE_PROVIDER`
 *    defaults to `'local'`): `/uploads/<folder>/<uuid>.<ext>`, where `<folder>`
 *    must be one of the folders passed to this decorator, `<uuid>` is a
 *    lowercase `randomUUID()` (the provider discards the client's original
 *    filename entirely) and `<ext>` is one the folder's upload endpoint can
 *    actually produce.
 *  - {@link S3StorageProvider}: an `http(s)` URL whose host matches
 *    `S3_PUBLIC_URL_HOST` *and* whose path ends in the same
 *    `<folder>/<uuid>.<ext>` shape. Until `S3_PUBLIC_URL_HOST` is set, no
 *    external host is accepted at all.
 *
 * Because the accepted pattern is fully anchored and only admits hex, dashes
 * and a known extension, traversal (`..`, `%2e%2e`, `\`), query strings,
 * fragments, double slashes, unexpected folders and arbitrary filenames are all
 * rejected as a consequence of the shape rather than by blocklisting. The
 * explicit pre-check below is defence in depth and keeps the intent readable.
 *
 * Note this is a *provenance/shape* check, not an existence check: it proves the
 * value looks like something our upload endpoint minted, not that the file is
 * still on disk. A dangling reference renders as a missing image on the client
 * (tracked separately as a frontend placeholder item), which is the correct
 * failure mode for a value that may be deleted after the fact.
 */

/** `randomUUID()` output: lowercase hex, RFC 4122 dashed form. */
const UUID_PATTERN =
  '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/**
 * The file extensions each upload folder can actually produce. Mirrors the
 * MIME allow-lists in `UploadsService` (and `PortfolioService` for `portfolio`)
 * mapped through the providers' `mimeToExt`. Keeping this per-folder is what
 * stops a `.svg`/`.pdf`/`.mp4` reference being accepted as a message image and
 * then announced to clients as a JPEG.
 */
const ALLOWED_EXTENSIONS_BY_FOLDER: Record<UploadFolder, readonly string[]> = {
  avatars: ['jpg', 'png', 'webp'],
  documents: ['jpg', 'png', 'webp', 'pdf'],
  selfies: ['jpg', 'png', 'webp'],
  portfolio: ['jpg', 'png', 'mp4'],
  'job-attachments': ['jpg', 'png', 'webp'],
  reviews: ['jpg', 'png'],
  messages: ['jpg', 'png'],
};

/** Anything with these in it can never be a provider-emitted URL. */
const SUSPICIOUS_PATTERN = /\.\.|%2e|%2f|%5c|[?#\\\s]/i;

function fileShapeFor(folders: readonly UploadFolder[]): string {
  return folders
    .map(
      (folder) =>
        `${folder}\\/${UUID_PATTERN}\\.(?:${ALLOWED_EXTENSIONS_BY_FOLDER[
          folder
        ].join('|')})`,
    )
    .join('|');
}

/**
 * @param folder - The upload folder (or folders) whose URLs this field accepts,
 *   e.g. `'messages'` for `POST /messages`'s `attachmentUrl`. Required: a field
 *   that accepts "any uploaded file" is the bug this argument exists to remove.
 */
export function IsAttachmentUrl(
  folder: UploadFolder | UploadFolder[],
  validationOptions?: ValidationOptions,
) {
  const folders = Array.isArray(folder) ? folder : [folder];
  const fileShape = fileShapeFor(folders);
  const localPattern = new RegExp(`^\\/uploads\\/(?:${fileShape})$`);
  const remotePathPattern = new RegExp(`\\/(?:${fileShape})$`);

  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isAttachmentUrl',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          if (typeof value !== 'string' || value.length === 0) return false;
          if (SUSPICIOUS_PATTERN.test(value)) return false;

          // LocalStorageProvider shape: /uploads/<folder>/<uuid>.<ext>
          if (localPattern.test(value)) return true;

          // S3StorageProvider shape: an http(s) URL on the configured S3
          // public/CDN host whose key ends in <folder>/<uuid>.<ext>. Read at
          // validation time so this needs no code change when S3 is wired up.
          const allowedHost = process.env.S3_PUBLIC_URL_HOST;
          if (allowedHost && /^https?:\/\//i.test(value)) {
            try {
              const url = new URL(value);
              return (
                url.host === allowedHost && remotePathPattern.test(url.pathname)
              );
            } catch {
              return false;
            }
          }

          return false;
        },
        defaultMessage() {
          const example = `/uploads/${folders[0]}/<uuid>.${ALLOWED_EXTENSIONS_BY_FOLDER[folders[0]][0]}`;
          return (
            `$property must be a file URL returned by this feature's own upload ` +
            `endpoint (e.g. "${example}"), not an arbitrary path or URL.`
          );
        },
      },
    });
  };
}
