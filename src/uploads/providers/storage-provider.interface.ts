export type UploadFolder =
  | 'avatars'
  | 'documents'
  | 'selfies'
  | 'portfolio'
  | 'job-attachments'
  | 'reviews'
  /** MC4: image attachments on direct messages. */
  | 'messages';

export interface UploadOptions {
  folder: UploadFolder;
  originalName: string;
  mimetype: string;
}

export interface UploadResult {
  url: string;
  filename: string;
  folder: UploadFolder;
  sizeBytes: number;
}

export interface IStorageProvider {
  readonly providerName: string;
  upload(buffer: Buffer, options: UploadOptions): Promise<UploadResult>;
  delete(filename: string, folder: UploadFolder): Promise<void>;
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
