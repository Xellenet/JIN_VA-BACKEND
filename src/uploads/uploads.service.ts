import { BadRequestException, Injectable } from '@nestjs/common';
import { StorageProviderFactory } from './providers/storage-provider.factory';
import type { UploadFolder } from './providers/storage-provider.interface';

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_DOCUMENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);

@Injectable()
export class UploadsService {
  constructor(private readonly factory: StorageProviderFactory) {}

  async uploadAvatar(file: Express.Multer.File) {
    this.assertMime(file, ALLOWED_IMAGE_TYPES, 'Avatars must be JPEG, PNG, or WebP.');
    return this.store(file, 'avatars');
  }

  async uploadDocument(file: Express.Multer.File) {
    this.assertMime(file, ALLOWED_DOCUMENT_TYPES, 'Documents must be JPEG, PNG, WebP, or PDF.');
    return this.store(file, 'documents');
  }

  async uploadSelfie(file: Express.Multer.File) {
    this.assertMime(file, ALLOWED_IMAGE_TYPES, 'Selfies must be JPEG, PNG, or WebP.');
    return this.store(file, 'selfies');
  }

  private async store(file: Express.Multer.File, folder: UploadFolder) {
    const provider = this.factory.getProvider();
    const result   = await provider.upload(file.buffer, {
      folder,
      originalName: file.originalname,
      mimetype:     file.mimetype,
    });
    return {
      message:  'File uploaded successfully.',
      url:      result.url,
      filename: result.filename,
      folder:   result.folder,
      bytes:    result.sizeBytes,
    };
  }

  private assertMime(file: Express.Multer.File, allowed: Set<string>, message: string) {
    if (!allowed.has(file.mimetype)) {
      throw new BadRequestException(message);
    }
  }
}
