import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import type {
  IStorageProvider,
  UploadFolder,
  UploadOptions,
  UploadResult,
} from './storage-provider.interface';

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
    const key = `${options.folder}/${filename}`;

    try {
      await this.getClient(config).send(
        new PutObjectCommand({
          Bucket: config.bucket,
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
      url: this.buildPublicUrl(config, key),
      filename,
      folder: options.folder,
      sizeBytes: buffer.length,
    };
  }

  async delete(filename: string, folder: UploadFolder): Promise<void> {
    const key = `${folder}/${filename}`;
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
        new DeleteObjectCommand({ Bucket: config.bucket, Key: key }),
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
      });
    }
    return this.client;
  }

  private buildPublicUrl(config: S3ProviderConfig, key: string): string {
    if (config.publicUrlBase) {
      return `${config.publicUrlBase.replace(/\/+$/, '')}/${key}`;
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
