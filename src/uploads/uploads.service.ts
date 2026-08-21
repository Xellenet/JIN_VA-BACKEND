import { BadRequestException, Injectable } from '@nestjs/common';
import { loadEsm } from 'load-esm';
import { StorageProviderFactory } from './providers/storage-provider.factory';
import type { UploadFolder } from './providers/storage-provider.interface';

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_DOCUMENT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
]);

@Injectable()
export class UploadsService {
  constructor(private readonly factory: StorageProviderFactory) {}

  async uploadAvatar(file: Express.Multer.File) {
    const mimetype = await this.assertMime(
      file,
      ALLOWED_IMAGE_TYPES,
      'Avatars must be JPEG, PNG, or WebP.',
    );
    return this.store(file, 'avatars', mimetype);
  }

  async uploadDocument(file: Express.Multer.File) {
    const mimetype = await this.assertMime(
      file,
      ALLOWED_DOCUMENT_TYPES,
      'Documents must be JPEG, PNG, WebP, or PDF.',
    );
    return this.store(file, 'documents', mimetype);
  }

  async uploadSelfie(file: Express.Multer.File) {
    const mimetype = await this.assertMime(
      file,
      ALLOWED_IMAGE_TYPES,
      'Selfies must be JPEG, PNG, or WebP.',
    );
    return this.store(file, 'selfies', mimetype);
  }

  /**
   * J4: photo attachments for a job (or a booking that will later become one
   * — see R2). Any authenticated user may call this; ownership of the
   * resulting job/booking is enforced where the URL is subsequently attached
   * (job creation / booking creation), not at upload time.
   */
  async uploadJobAttachment(file: Express.Multer.File) {
    const mimetype = await this.assertMime(
      file,
      ALLOWED_IMAGE_TYPES,
      'Job attachments must be JPEG, PNG, or WebP.',
    );
    return this.store(file, 'job-attachments', mimetype);
  }

  private async store(
    file: Express.Multer.File,
    folder: UploadFolder,
    mimetype: string,
  ) {
    const provider = this.factory.getProvider();
    const result = await provider.upload(file.buffer, {
      folder,
      originalName: file.originalname,
      mimetype,
    });
    return {
      message: 'File uploaded successfully.',
      url: result.url,
      filename: result.filename,
      folder: result.folder,
      bytes: result.sizeBytes,
    };
  }

  /**
   * Validates a file's declared mimetype against an allow-list, then sniffs
   * the actual bytes' magic number (via `file-type`) and requires the
   * *detected* type to also be on the allow-list — the client-declared
   * `Content-Type` header alone is attacker-controlled and not trustworthy
   * on its own (see the identical fix/rationale in
   * `PortfolioService.assertValidFile`). Returns the detected type, which
   * callers must use for storage instead of `file.mimetype`.
   */
  private async assertMime(
    file: Express.Multer.File,
    allowed: Set<string>,
    message: string,
  ): Promise<string> {
    if (!allowed.has(file.mimetype)) {
      throw new BadRequestException(message);
    }
    const { fileTypeFromBuffer } =
      await loadEsm<typeof import('file-type')>('file-type');
    const detected = await fileTypeFromBuffer(file.buffer);
    if (!detected || !allowed.has(detected.mime)) {
      throw new BadRequestException(message);
    }
    return detected.mime;
  }
}
