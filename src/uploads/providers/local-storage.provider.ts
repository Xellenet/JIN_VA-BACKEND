import { Injectable, Logger } from '@nestjs/common';
import { writeFile, unlink, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  IStorageProvider,
  UploadFolder,
  UploadOptions,
  UploadResult,
} from './storage-provider.interface';

@Injectable()
export class LocalStorageProvider implements IStorageProvider {
  readonly providerName = 'local';
  private readonly logger = new Logger(LocalStorageProvider.name);
  private readonly baseDir = join(process.cwd(), 'uploads');

  async upload(buffer: Buffer, options: UploadOptions): Promise<UploadResult> {
    const folderPath = join(this.baseDir, options.folder);
    if (!existsSync(folderPath)) {
      await mkdir(folderPath, { recursive: true });
    }

    // Security: the stored extension is derived solely from the (caller-
    // validated) MIME type, never from the client-supplied original
    // filename — otherwise an attacker could upload e.g. `payload.html`
    // with a spoofed image `Content-Type` and have it served back as
    // `text/html` by Express's extension-based static-file Content-Type
    // inference (see the security report for the full exploit chain).
    const ext = this.mimeToExt(options.mimetype);
    const filename = `${randomUUID()}${ext}`;
    const filePath = join(folderPath, filename);

    await writeFile(filePath, buffer);
    this.logger.log(
      `Saved ${options.folder}/${filename} (${buffer.length} bytes)`,
    );

    return {
      url: `/uploads/${options.folder}/${filename}`,
      filename,
      folder: options.folder,
      sizeBytes: buffer.length,
    };
  }

  async delete(filename: string, folder: UploadFolder): Promise<void> {
    const filePath = join(this.baseDir, folder, filename);
    try {
      await unlink(filePath);
    } catch {
      // File may already be gone — not fatal
    }
  }

  private mimeToExt(mimetype: string): string {
    const map: Record<string, string> = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/webp': '.webp',
      'image/gif': '.gif',
      'application/pdf': '.pdf',
      'video/mp4': '.mp4',
    };
    return map[mimetype] ?? '.bin';
  }
}
