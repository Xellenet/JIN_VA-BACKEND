import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import type {
  IStorageProvider,
  PrivateMediaObject,
  PrivateUploadFolder,
  PublicMediaObject,
  PublicUploadFolder,
  UploadFolder,
  UploadOptions,
  UploadResult,
} from './storage-provider.interface';
import {
  buildPrivateMediaReference,
  buildS3ObjectKey,
  isPrivateUploadFolder,
  type SharedPrivateUploadFolder,
} from '../upload-folders';
import { LEGACY_MEDIA_PREFIX } from '../legacy-media.config';

/**
 * PF2a: S3-backed implementation of {@link IStorageProvider}, built ahead of
 * the user's planned migration away from local disk storage. Conforms to the
 * exact same interface as {@link LocalStorageProvider} so
 * `StorageProviderFactory` can swap between them purely via `STORAGE_PROVIDER`.
 *
 * NOT active by default — `StorageProviderFactory` only returns this provider
 * when `process.env.STORAGE_PROVIDER === 's3'`. Flipping that variable is the
 * operator's action; nothing in this codebase sets it.
 *
 * Configuration is read exclusively via named environment variables (never
 * read/opened as files by this codebase) — see `api-contract.md` for the
 * full list:
 * - `AWS_S3_BUCKET`            (required when active)
 * - `AWS_S3_REGION`            (required when active)
 * - `AWS_S3_ACCESS_KEY_ID`     (optional — falls back to the default AWS SDK
 *                                credential chain, e.g. IAM role, when unset)
 * - `AWS_S3_SECRET_ACCESS_KEY` (optional, paired with the access key above)
 * - `AWS_S3_PUBLIC_URL_BASE`   (optional — e.g. a CDN domain fronting the
 *                                bucket; falls back to the bucket's virtual-
 *                                hosted-style S3 URL when unset)
 * - `AWS_S3_ENDPOINT`          (optional — an S3-compatible service instead of
 *                                AWS, e.g. Backblaze B2's
 *                                `https://s3.<region>.backblazeb2.com`. Turns
 *                                on path-style addressing, and public URLs
 *                                default to `<endpoint>/<bucket>/<key>`)
 * - `AWS_S3_PRIVATE_BUCKET`    (optional — a separate bucket for the private
 *                                KYC folders. Required in practice on services
 *                                like B2, where visibility is per bucket, not
 *                                per prefix: in one public bucket the
 *                                `private/` prefix would be publicly readable)
 * - `STORAGE_PUBLIC_DELIVERY`  (optional — how public-folder media reaches
 *                                browsers. `direct` (default): the URL points
 *                                at the bucket, which must be public. `proxy`:
 *                                the URL is `/uploads/<folder>/<file>` and this
 *                                process streams it from the bucket (see
 *                                `bucket-media-serving.ts`), so the bucket can
 *                                stay private. Switching proxy → direct later
 *                                needs no data change: proxied URLs already
 *                                stored keep working through the same route)
 *
 * BI1 (failure discipline). Three rules hold for every code path below:
 *  1. **Never a silent no-op success.** Required configuration is validated
 *     *before* any key is minted, so a misconfigured provider can never
 *     return a URL for an object that was not written.
 *  2. **Never provider detail to the client.** Every AWS SDK failure is
 *     translated into a fixed, generic 5xx message. S3 error payloads can
 *     echo request-signing material, bucket ARNs and access-key identifiers,
 *     and `AllExceptionsFilter` passes an exception's own message straight
 *     through whenever `NODE_ENV !== 'production'` — so sanitising here (not
 *     relying on the filter) is what actually guarantees no leak.
 *  3. **Names, never values, in logs.** Diagnostics log the missing variable
 *     *names* and the AWS error *name* (e.g. `NoSuchBucket`, `AccessDenied`,
 *     `InvalidAccessKeyId`) — enough to fix a cutover, and provably free of
 *     any credential value.
 *
 * Public vs private keys. `buildPublicUrl` used to be applied to every
 * `UploadFolder`, including `documents` and `selfies` — so the cutover would
 * have published identity documents and KYC selfies to a public CDN prefix.
 * The key namespace is now split by sensitivity (see `../upload-folders`):
 * public folders keep the exact key and URL they have always had, while
 * `documents`/`selfies` are written under the `private/` key prefix
 * (`PRIVATE_S3_KEY_PREFIX`) and **never** get a public URL minted for them —
 * `upload()` returns a non-fetchable reference instead, and the only way to
 * read one back is the authenticated, admin-only
 * `GET /uploads/kyc/:folder/:filename` endpoint, which streams through
 * `readPrivate()`.
 *
 * `AWS_S3_PUBLIC_URL_BASE` must not be configured to front the `private/`
 * prefix. The prefix is not the access control — the admin guard is — but it
 * means a bucket policy or CDN behaviour can be written against a stable path,
 * and that a public bucket default cannot expose a KYC object through the same
 * URL shape the frontend already knows for avatars and portfolio items.
 */
@Injectable()
export class S3StorageProvider implements IStorageProvider {
  readonly providerName = 's3';
  private readonly logger = new Logger(S3StorageProvider.name);
  private client: S3Client | undefined;

  /**
   * The single client-facing message for any storage failure. Deliberately
   * says nothing about the provider, the bucket, the region or the reason.
   */
  private static readonly CLIENT_FAILURE_MESSAGE =
    'File storage is temporarily unavailable. Please try again later.';

  async upload(buffer: Buffer, options: UploadOptions): Promise<UploadResult> {
    // Rule 1: validate first. Nothing below this line can produce a URL for
    // an object that was never written.
    const config = this.requireConfiguration();

    // Security: derive the stored extension solely from the (caller-
    // validated) MIME type, never from the client-supplied original
    // filename — see the identical note in `LocalStorageProvider.upload`.
    const ext = this.mimeToExt(options.mimetype);
    const filename = `${randomUUID()}${ext}`;
    // Private folders land under the `private/` prefix; public folders keep
    // the exact key they have always had, so no existing object moves.
    const key = buildS3ObjectKey(options.folder, filename);

    try {
      await this.getClient(config).send(
        new PutObjectCommand({
          Bucket: bucketFor(config, options.folder),
          Key: key,
          Body: buffer,
          ContentType: options.mimetype,
        }),
      );
    } catch (err) {
      throw this.failLoudly('upload', key, err);
    }

    this.logger.log(`Uploaded ${key} to S3 (${buffer.length} bytes)`);

    return {
      // A KYC object never gets a public URL minted for it — not even one that
      // happens to be unreadable today, because a stored public URL is exactly
      // what turns a later bucket-policy mistake into a data breach.
      url: isPrivateUploadFolder(options.folder)
        ? buildPrivateMediaReference(options.folder, filename)
        : config.publicDelivery === 'proxy'
          ? `${LEGACY_MEDIA_PREFIX}/${options.folder}/${filename}`
          : this.buildPublicUrl(config, key),
      filename,
      folder: options.folder,
      sizeBytes: buffer.length,
    };
  }

  async delete(filename: string, folder: UploadFolder): Promise<void> {
    const key = buildS3ObjectKey(folder, filename);
    let config: S3ProviderConfig;
    try {
      config = this.requireConfiguration();
    } catch {
      // Mirrors the tolerance below: a delete is best-effort cleanup and must
      // never fail the caller's request. The boot-time check in
      // `StorageProviderFactory` is what makes a misconfiguration loud.
      this.logger.warn(
        `Skipped deleting ${key}: the S3 provider is not fully configured (see the boot-time storage configuration error).`,
      );
      return;
    }

    try {
      await this.getClient(config).send(
        new DeleteObjectCommand({
          Bucket: bucketFor(config, folder),
          Key: key,
        }),
      );
    } catch (err) {
      // Mirrors LocalStorageProvider: an already-gone/unreachable object is
      // not fatal. Logged by AWS error *name* only (rule 3).
      this.logger.warn(
        `Failed to delete ${key} from S3: ${describeAwsFailure(err)}`,
      );
    }
  }

  /**
   * Streams a KYC object back for the authenticated, admin-only endpoint.
   * Returns `null` when the bucket does not hold it, so the caller can fall
   * back to local disk (where every pre-cutover document still lives).
   *
   * Deliberately a stream rather than a presigned GET URL:
   *  - it behaves identically in local and S3 mode, so the admin screen has
   *    one code path instead of two;
   *  - no anonymously-fetchable URL for a KYC object is ever minted, so there
   *    is nothing to leak, replay, forward or land in a referrer header —
   *    which is the whole failure mode being fixed here;
   *  - it needs no extra dependency (`@aws-sdk/s3-request-presigner` is not
   *    installed) and no signing secret.
   * The cost is that these bytes pass through the app server, which PRD §9
   * asks media not to do. That is an accepted, documented deviation scoped to
   * this one prefix: KYC review is admin-only, rare, and capped at 10MB per
   * object by the upload validators.
   */
  async readPrivate(
    folder: PrivateUploadFolder,
    filename: string,
  ): Promise<PrivateMediaObject | null> {
    return this.readObject(folder, filename);
  }

  /**
   * Streams a public-folder object for proxied delivery
   * (`STORAGE_PUBLIC_DELIVERY=proxy`). Same contract as `readPrivate`: `null`
   * when the bucket does not hold it, so the caller can fall back to legacy
   * local disk. `range` is a validated `bytes=` header, passed through so
   * portfolio videos can seek.
   */
  async readPublic(
    folder: PublicUploadFolder,
    filename: string,
    range?: string,
  ): Promise<PublicMediaObject | null> {
    return this.readObject(folder, filename, range);
  }

  /**
   * QA MSG-18: a message or job photo uploaded before those folders became
   * private still sits at its old public key in the main bucket. The private
   * media endpoint reads it from there, behind its own access check, so old
   * conversations keep their images.
   */
  async readLegacyShared(
    folder: SharedPrivateUploadFolder,
    filename: string,
  ): Promise<PrivateMediaObject | null> {
    return this.readObject(folder, filename, undefined, 'legacy-public');
  }

  private async readObject(
    folder: UploadFolder,
    filename: string,
    range?: string,
    location: 'current' | 'legacy-public' = 'current',
  ): Promise<PublicMediaObject | null> {
    const config = this.requireConfiguration();
    const key =
      location === 'legacy-public'
        ? `${folder}/${filename}`
        : buildS3ObjectKey(folder, filename);

    try {
      const output = await this.getClient(config).send(
        new GetObjectCommand({
          Bucket:
            location === 'legacy-public'
              ? config.bucket
              : bucketFor(config, folder),
          Key: key,
          ...(range ? { Range: range } : {}),
        }),
      );
      if (!output.Body) return null;
      return {
        stream: output.Body as Readable,
        contentType: output.ContentType ?? 'application/octet-stream',
        contentLength: output.ContentLength,
        contentRange: output.ContentRange,
      };
    } catch (err) {
      if (isMissingObject(err)) return null;
      throw this.failLoudly('read', key, err);
    }
  }

  /**
   * BI1: the names of the required `AWS_S3_*` variables that are absent or
   * blank. Values are never read into a log, a message or a return value.
   */
  missingConfiguration(): string[] {
    const missing: string[] = [];
    if (!readEnv('AWS_S3_BUCKET')) missing.push('AWS_S3_BUCKET');
    // Required even when `AWS_S3_PUBLIC_URL_BASE` is set: the SDK needs it to
    // sign requests, and the fallback public URL embeds it. Left unset, the
    // SDK can still silently pick a region up from the ambient `AWS_REGION`
    // and succeed — while `buildPublicUrl` writes
    // `https://<bucket>.s3.undefined.amazonaws.com/...` into the database,
    // permanently breaking that asset. That is exactly the silent-wrong-
    // success this check exists to prevent.
    if (!readEnv('AWS_S3_REGION')) missing.push('AWS_S3_REGION');
    // On an S3-compatible endpoint visibility is per bucket, so KYC objects
    // in the main (public) bucket would be anonymously readable. Refuse to
    // run that way rather than rely on the `private/` prefix.
    const delivery = readEnv('STORAGE_PUBLIC_DELIVERY');
    if (delivery && delivery !== 'direct' && delivery !== 'proxy') {
      missing.push('STORAGE_PUBLIC_DELIVERY');
    }
    const privateBucket = readEnv('AWS_S3_PRIVATE_BUCKET');
    if (readEnv('AWS_S3_ENDPOINT')) {
      // Direct delivery means the main bucket is public, so KYC needs a
      // *different* one; proxied delivery may keep everything in a single
      // private bucket, but it still has to be named explicitly.
      if (
        !privateBucket ||
        (delivery !== 'proxy' && privateBucket === readEnv('AWS_S3_BUCKET'))
      ) {
        missing.push('AWS_S3_PRIVATE_BUCKET');
      }
    }
    return missing;
  }

  /**
   * Throws a clean 5xx naming the missing variables (names only) when the
   * provider cannot possibly work. `InternalServerErrorException` rather than
   * a bare `Error` so the status is deliberate rather than an accident of the
   * global filter's fallback.
   */
  private requireConfiguration(): S3ProviderConfig {
    const missing = this.missingConfiguration();
    if (missing.length > 0) {
      const detail = missing
        .map((name) => `${name} is not configured`)
        .join('; ');
      const message = `${detail}. Set the missing AWS_S3_* variables before running with STORAGE_PROVIDER="s3".`;
      this.logger.error(message);
      throw new InternalServerErrorException(message);
    }
    return {
      bucket: readEnv('AWS_S3_BUCKET')!,
      region: readEnv('AWS_S3_REGION')!,
      publicUrlBase: readEnv('AWS_S3_PUBLIC_URL_BASE'),
      endpoint: readEnv('AWS_S3_ENDPOINT')?.replace(/\/+$/, ''),
      privateBucket: readEnv('AWS_S3_PRIVATE_BUCKET'),
      publicDelivery:
        readEnv('STORAGE_PUBLIC_DELIVERY') === 'proxy' ? 'proxy' : 'direct',
    };
  }

  /**
   * Logs the real reason server-side (AWS error name only) and returns the
   * sanitised exception to throw at the caller.
   */
  private failLoudly(
    operation: string,
    key: string,
    err: unknown,
  ): InternalServerErrorException {
    this.logger.error(
      `S3 ${operation} failed for ${key}: ${describeAwsFailure(err)}. ` +
        `Check the AWS_S3_* configuration and the bucket's write permissions.`,
    );
    return new InternalServerErrorException(
      S3StorageProvider.CLIENT_FAILURE_MESSAGE,
    );
  }

  private getClient(config: S3ProviderConfig): S3Client {
    if (!this.client) {
      const accessKeyId = readEnv('AWS_S3_ACCESS_KEY_ID');
      const secretAccessKey = readEnv('AWS_S3_SECRET_ACCESS_KEY');
      this.client = new S3Client({
        region: config.region,
        credentials:
          accessKeyId && secretAccessKey
            ? { accessKeyId, secretAccessKey }
            : undefined,
        // S3-compatible services (e.g. Backblaze B2) are reached at their own
        // endpoint with path-style URLs, and only send the SDK's default
        // CRC checksum headers when an operation requires them — newer SDKs
        // add them to every request, and not every compatible service
        // accepts them.
        ...(config.endpoint
          ? {
              endpoint: config.endpoint,
              forcePathStyle: true,
              requestChecksumCalculation: 'WHEN_REQUIRED' as const,
              responseChecksumValidation: 'WHEN_REQUIRED' as const,
            }
          : {}),
      });
    }
    return this.client;
  }

  private buildPublicUrl(config: S3ProviderConfig, key: string): string {
    if (config.publicUrlBase) {
      return `${config.publicUrlBase.replace(/\/+$/, '')}/${key}`;
    }
    if (config.endpoint) {
      return `${config.endpoint}/${config.bucket}/${key}`;
    }
    return `https://${config.bucket}.s3.${config.region}.amazonaws.com/${key}`;
  }

  private mimeToExt(mimetype: string): string {
    const map: Record<string, string> = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/webp': '.webp',
      'image/gif': '.gif',
      'video/mp4': '.mp4',
      'application/pdf': '.pdf',
    };
    const ext = map[mimetype];
    if (!ext) {
      // Unreachable while every caller validates against an allow-list that
      // is a subset of this map (see `UploadsService.assertMime` and
      // `PortfolioService.assertValidFile`). Logged rather than silently
      // stored as `.bin`, because a wrong extension on a CDN-served object is
      // the kind of breakage nobody notices until a user reports it.
      this.logger.warn(
        `No extension mapping for MIME type "${mimetype}" — storing with a .bin extension.`,
      );
      return '.bin';
    }
    return ext;
  }
}

interface S3ProviderConfig {
  bucket: string;
  region: string;
  publicUrlBase?: string;
  endpoint?: string;
  privateBucket?: string;
  publicDelivery: 'direct' | 'proxy';
}

/**
 * Private (KYC) folders go to `AWS_S3_PRIVATE_BUCKET` when it is set, and to
 * the main bucket otherwise — the existing single-bucket AWS behaviour.
 */
function bucketFor(config: S3ProviderConfig, folder: UploadFolder): string {
  return isPrivateUploadFolder(folder) && config.privateBucket
    ? config.privateBucket
    : config.bucket;
}

/** Trims so a variable set to whitespace counts as unset. */
function readEnv(name: string): string | undefined {
  const value = process.env[name];
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * BI1 rule 3: describes an AWS SDK failure using its error *name* and HTTP
 * status only. The SDK's `message`/`stack` are deliberately not logged — S3
 * error payloads can echo the access-key identifier and signing details, and
 * a log line is just as much "agent output" as a response body.
 */
function describeAwsFailure(err: unknown): string {
  const name = err instanceof Error && err.name ? err.name : 'UnknownError';
  const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata
    ?.httpStatusCode;
  return status ? `${name} (HTTP ${status})` : name;
}

/**
 * "The bucket does not hold this key" is a legitimate outcome for
 * `readPrivate` — a pre-cutover document is on local disk, not in the bucket —
 * so it must not be reported as a storage failure. Every *other* AWS error
 * still goes through `failLoudly`.
 */
function isMissingObject(err: unknown): boolean {
  const name = err instanceof Error ? err.name : '';
  if (name === 'NoSuchKey' || name === 'NotFound') return true;
  return (
    (err as { $metadata?: { httpStatusCode?: number } })?.$metadata
      ?.httpStatusCode === 404
  );
}
