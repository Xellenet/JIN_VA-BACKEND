import { Injectable, Logger } from '@nestjs/common';
import { writeFile, unlink, mkdir, stat } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  IStorageProvider,
  PrivateMediaObject,
  PrivateUploadFolder,
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

  /**
   * Opens a KYC object from disk for the authenticated admin-only endpoint.
   *
   * This is also the path that keeps **pre-cutover** documents readable after
   * `STORAGE_PROVIDER=s3`: those bytes physically live here, not in the
   * bucket, so `KycMediaService` asks local disk first regardless of which
   * provider is active — the same reasoning as BI2's legacy static mount, but
   * behind an admin guard rather than a public URL.
   *
   * The on-disk layout is deliberately unchanged (`uploads/documents/...`, not
   * `uploads/private/documents/...`): every historical row points at the
   * current path, and moving the files would break all of them. What changed
   * is that `applyLegacyMediaServing` no longer mounts these two folders, so
   * nothing serves them anonymously.
   */
  async readPrivate(
    folder: PrivateUploadFolder,
    filename: string,
  ): Promise<PrivateMediaObject | null> {
    // `basename` is a second line of defence behind the caller's
    // `isSafeMediaFilename` check — a path separator can never survive both.
    const safeName = basename(filename);
    const filePath = join(this.baseDir, folder, safeName);
    if (!existsSync(filePath)) return null;

    const stats = await stat(filePath);
    if (!stats.isFile()) return null;

    return {
      stream: createReadStream(filePath),
      contentType: extToMime(extname(safeName)),
      contentLength: stats.size,
    };
  }

  /**
   * BI1: local disk needs no environment configuration — the upload root is
   * derived from `process.cwd()` and created on demand — so there is never
   * anything missing to report.
   */
  missingConfiguration(): string[] {
    return [];
  }

  private mimeToExt(mimetype: string): string {
    return MIME_TO_EXT[mimetype] ?? '.bin';
  }
}

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'application/pdf': '.pdf',
  'video/mp4': '.mp4',
};

/**
 * Reverse of {@link MIME_TO_EXT}. Used only when reading a private object
 * back: unlike the public static mount (which lets `send` infer the type), the
 * KYC endpoint sets `Content-Type` itself, and the stored extension is already
 * derived from sniffed bytes rather than a client-supplied filename. Anything
 * unrecognised is served as a download rather than guessed at.
 */
function extToMime(ext: string): string {
  const lower = ext.toLowerCase();
  for (const [mime, mapped] of Object.entries(MIME_TO_EXT)) {
    if (mapped === lower) return mime;
  }
  return 'application/octet-stream';
}
