import { Injectable, Logger } from '@nestjs/common';
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
 * when `process.env.STORAGE_PROVIDER === 's3'`, which no environment sets today.
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
 */
@Injectable()
export class S3StorageProvider implements IStorageProvider {
  readonly providerName = 's3';
  private readonly logger = new Logger(S3StorageProvider.name);
  private client: S3Client | undefined;

  async upload(buffer: Buffer, options: UploadOptions): Promise<UploadResult> {
    // Security: derive the stored extension solely from the (caller-
    // validated) MIME type, never from the client-supplied original
    // filename — see the identical note in `LocalStorageProvider.upload`.
    const ext = this.mimeToExt(options.mimetype);
    const filename = `${randomUUID()}${ext}`;
    const key = `${options.folder}/${filename}`;

    await this.getClient().send(
      new PutObjectCommand({
        Bucket: this.getBucket(),
        Key: key,
        Body: buffer,
        ContentType: options.mimetype,
      }),
    );

    this.logger.log(
      `Uploaded ${key} to S3 bucket ${this.getBucket()} (${buffer.length} bytes)`,
    );

    return {
      url: this.buildPublicUrl(key),
      filename,
      folder: options.folder,
      sizeBytes: buffer.length,
    };
  }

  async delete(filename: string, folder: UploadFolder): Promise<void> {
    const key = `${folder}/${filename}`;
    try {
      await this.getClient().send(
        new DeleteObjectCommand({ Bucket: this.getBucket(), Key: key }),
      );
    } catch (err) {
      // Mirrors LocalStorageProvider: an already-gone/unreachable object is not fatal.
      this.logger.warn(
        `Failed to delete ${key} from S3: ${(err as Error).message}`,
      );
    }
  }

  private getClient(): S3Client {
    if (!this.client) {
      const accessKeyId = process.env.AWS_S3_ACCESS_KEY_ID;
      const secretAccessKey = process.env.AWS_S3_SECRET_ACCESS_KEY;
      this.client = new S3Client({
        region: process.env.AWS_S3_REGION,
        credentials:
          accessKeyId && secretAccessKey
            ? { accessKeyId, secretAccessKey }
            : undefined,
      });
    }
    return this.client;
  }

  private getBucket(): string {
    const bucket = process.env.AWS_S3_BUCKET;
    if (!bucket) {
      throw new Error(
        'AWS_S3_BUCKET is not configured. Set it before switching STORAGE_PROVIDER to "s3".',
      );
    }
    return bucket;
  }

  private buildPublicUrl(key: string): string {
    const base = process.env.AWS_S3_PUBLIC_URL_BASE;
    if (base) return `${base.replace(/\/+$/, '')}/${key}`;
    return `https://${this.getBucket()}.s3.${process.env.AWS_S3_REGION}.amazonaws.com/${key}`;
  }

  private mimeToExt(mimetype: string): string {
    const map: Record<string, string> = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/webp': '.webp',
      'video/mp4': '.mp4',
      'application/pdf': '.pdf',
    };
    return map[mimetype] ?? '.bin';
  }
}
