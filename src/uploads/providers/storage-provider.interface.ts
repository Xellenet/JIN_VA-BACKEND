import type { Readable } from 'node:stream';
import type { PrivateUploadFolder } from '../upload-folders';

/**
 * The folder union now lives in `../upload-folders`, alongside the
 * public/private sensitivity split that decides whether a folder may ever be
 * served from an anonymously-readable URL. Re-exported here so the many
 * existing `import type { UploadFolder } from './storage-provider.interface'`
 * call sites keep working.
 */
export type {
  UploadFolder,
  PrivateUploadFolder,
  PublicUploadFolder,
} from '../upload-folders';

import type { UploadFolder } from '../upload-folders';

export interface UploadOptions {
  folder: UploadFolder;
  originalName: string;
  mimetype: string;
}

export interface UploadResult {
  /**
   * For a public folder: the fetchable public/CDN URL (S3) or the relative
   * `/uploads/...` path (local disk).
   *
   * For a private folder (`documents`/`selfies`): a non-fetchable reference —
   * see `buildPrivateMediaReference`. Nothing serves it in either storage
   * mode; it is read back only through the authenticated admin-only
   * `GET /uploads/kyc/:folder/:filename` endpoint.
   */
  url: string;
  filename: string;
  folder: UploadFolder;
  sizeBytes: number;
}

/** A private object opened for streaming to an authenticated admin. */
export interface PrivateMediaObject {
  stream: Readable;
  contentType: string;
  /** Omitted when the store cannot report it; the response then has no `Content-Length`. */
  contentLength?: number;
}

export interface IStorageProvider {
  readonly providerName: string;
  upload(buffer: Buffer, options: UploadOptions): Promise<UploadResult>;
  delete(filename: string, folder: UploadFolder): Promise<void>;
  /**
   * Opens a KYC object (`documents`/`selfies`) for reading. Returns `null`
   * when this store does not hold it, so the caller can try the other store —
   * a pre-cutover document lives on local disk even while `STORAGE_PROVIDER`
   * is `s3`, which is the same legacy-media problem BI2 solved for the public
   * folders.
   *
   * Only ever reached from the authenticated, admin-only KYC endpoint. The
   * caller is responsible for validating `filename` (see
   * `isSafeMediaFilename`).
   */
  readPrivate(
    folder: PrivateUploadFolder,
    filename: string,
  ): Promise<PrivateMediaObject | null>;
  /**
   * BI1: the **names** (never the values) of the environment variables this
   * provider requires but cannot find. Empty means the provider is usable.
   *
   * `StorageProviderFactory` calls this once at boot so a misconfigured
   * cutover is loud in the logs immediately instead of only surfacing on the
   * first user upload, and each provider re-checks it on every `upload()` so
   * a misconfiguration can never turn into a silent no-op success.
   */
  missingConfiguration(): string[];
}
