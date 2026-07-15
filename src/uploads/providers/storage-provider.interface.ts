export type UploadFolder = 'avatars' | 'documents' | 'selfies';

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
}
