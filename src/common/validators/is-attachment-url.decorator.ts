import { registerDecorator, ValidationOptions } from 'class-validator';

/**
 * Security report finding (Low, CWE-20): `attachmentUrls` previously accepted
 * any string with no URL/format validation, allowing a customer to reference
 * an arbitrary, non-uploaded URL as a job/booking attachment.
 *
 * Round 1 fix note claimed the `http(s)` branch was restricted to the
 * storage provider's own returned shape, but it actually accepted *any*
 * well-formed `http(s)://` URL regardless of host (security re-verification,
 * round 2 — confirmed `https://evil.example/x.jpg` still validated as true).
 *
 * This validator now only accepts the exact shapes `UploadResult.url` can
 * actually return today (`src/uploads/providers/storage-provider.interface.ts`):
 *  - `LocalStorageProvider` (the only active provider — `STORAGE_PROVIDER`
 *    defaults to `'local'`, see `storage-provider.factory.ts`): a same-origin
 *    relative path under `/uploads/` (e.g. `/uploads/job-attachments/<uuid>.jpg`).
 *  - `S3StorageProvider`: an `http(s)://` URL whose host matches the
 *    configured S3 public/CDN host (`S3_PUBLIC_URL_HOST`), read at validation
 *    time so this doesn't need a code change when S3 is actually wired up.
 *    Until `S3_PUBLIC_URL_HOST` is set, no external host is accepted at all —
 *    narrowing the attack surface to zero for a provider that isn't active in
 *    any current environment, per the security report's recommendation (b).
 *
 * Anything else (a bare filename, a `javascript:`/`data:` URI, an arbitrary
 * unrelated host) is rejected.
 */
export function IsAttachmentUrl(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isAttachmentUrl',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          if (typeof value !== 'string' || value.length === 0) return false;

          // LocalStorageProvider shape: relative path under /uploads/.
          if (value.startsWith('/uploads/')) return true;

          // S3StorageProvider shape: an http(s) URL whose host matches the
          // configured S3 public/CDN host. Unset by default, so this branch
          // accepts nothing until S3 is actually configured.
          const allowedHost = process.env.S3_PUBLIC_URL_HOST;
          if (allowedHost && /^https?:\/\//i.test(value)) {
            try {
              const url = new URL(value);
              return url.host === allowedHost;
            } catch {
              return false;
            }
          }

          return false;
        },
        defaultMessage() {
          return (
            '$property must be an uploaded file URL ' +
            '(a "/uploads/..." path, or an http(s) URL on the configured ' +
            'storage host), not an arbitrary string.'
          );
        },
      },
    });
  };
}
