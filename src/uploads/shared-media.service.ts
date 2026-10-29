import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Role } from '@common/types/enums';
import { LocalStorageProvider } from './providers/local-storage.provider';
import { S3StorageProvider } from './providers/s3-storage.provider';
import { StorageProviderFactory } from './providers/storage-provider.factory';
import type { PrivateMediaObject } from './providers/storage-provider.interface';
import {
  isSafeMediaFilename,
  isSharedPrivateUploadFolder,
  SHARED_PRIVATE_UPLOAD_FOLDERS,
  type SharedPrivateUploadFolder,
} from './upload-folders';

export interface MediaViewer {
  id: number;
  role: Role;
}

/**
 * QA MSG-18: message and job/booking photos used to be readable by anyone
 * holding the URL. Each read now checks that the caller is one of the people
 * the file was shared with:
 *
 * - a message image: the two people in that conversation, and an admin only
 *   while a dispute between those two is OPEN or UNDER_REVIEW (the same window
 *   in which `GET /admin/disputes/:id/conversation` shows the thread itself);
 * - a job photo: whoever may read the job, the rule `JobsService.canViewJob`
 *   applies (admins, its customer, its accepted artisan, artisans who applied,
 *   and any artisan while it is OPEN), restated in SQL here so this module
 *   needn't depend on the jobs module;
 * - a booking photo: the booking's customer and artisan, and admins.
 *
 * A file nobody may see, and a file that doesn't exist, get the same 404, so
 * the endpoint never confirms that a file exists.
 */
@Injectable()
export class SharedMediaService {
  private readonly logger = new Logger(SharedMediaService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly factory: StorageProviderFactory,
    private readonly localProvider: LocalStorageProvider,
    private readonly s3Provider: S3StorageProvider,
  ) {}

  async open(
    folder: string,
    filename: string,
    viewer: MediaViewer,
  ): Promise<PrivateMediaObject> {
    if (!isSharedPrivateUploadFolder(folder)) {
      throw new BadRequestException(
        `Unknown media folder. Expected one of: ${SHARED_PRIVATE_UPLOAD_FOLDERS.join(', ')}.`,
      );
    }
    if (!isSafeMediaFilename(filename)) {
      throw new BadRequestException('Invalid media filename.');
    }

    const allowed =
      folder === 'messages'
        ? await this.canViewMessageMedia(filename, viewer)
        : await this.canViewJobMedia(filename, viewer);
    if (!allowed) throw this.notFound();

    const object = await this.read(folder, filename);
    if (!object) throw this.notFound();
    return object;
  }

  private notFound() {
    return new NotFoundException('That file is not available.');
  }

  /** Stored references end in `/<folder>/<filename>`, whatever came before. */
  private suffix(folder: SharedPrivateUploadFolder, filename: string): string {
    return `/${folder}/${filename}`;
  }

  private async canViewMessageMedia(
    filename: string,
    viewer: MediaViewer,
  ): Promise<boolean> {
    const suffix = this.suffix('messages', filename);
    const rows: Array<{ a: number; b: number }> = await this.dataSource.query(
      `SELECT c.participant_a_id AS a, c.participant_b_id AS b
         FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE right(m.attachment_url, length($1)) = $1`,
      [suffix],
    );
    if (rows.some((r) => r.a === viewer.id || r.b === viewer.id)) return true;
    if (viewer.role !== Role.ADMIN || rows.length === 0) return false;

    const [{ open }]: Array<{ open: boolean }> = await this.dataSource.query(
      `SELECT EXISTS (
         SELECT 1 FROM disputes d
           JOIN bookings b ON b.id = d.booking_id
           JOIN artisan_profiles ap ON ap.id = b.artisan_profile_id
          WHERE d.status IN ('OPEN', 'UNDER_REVIEW')
            AND (b.customer_id, ap.user_id) IN (
              SELECT c.participant_a_id, c.participant_b_id FROM conversations c
               WHERE c.id IN (SELECT conversation_id FROM messages WHERE right(attachment_url, length($1)) = $1)
              UNION
              SELECT c.participant_b_id, c.participant_a_id FROM conversations c
               WHERE c.id IN (SELECT conversation_id FROM messages WHERE right(attachment_url, length($1)) = $1)
            )
       ) AS open`,
      [suffix],
    );
    return open;
  }

  private async canViewJobMedia(
    filename: string,
    viewer: MediaViewer,
  ): Promise<boolean> {
    const suffix = this.suffix('job-attachments', filename);
    const jobs: Array<{
      id: number;
      status: string;
      customer_id: number;
      accepted_artisan_id: number | null;
    }> = await this.dataSource.query(
      `SELECT j.id, j.status, j.customer_id, j.accepted_artisan_id
         FROM job_attachments ja JOIN jobs j ON j.id = ja.job_id
        WHERE j.deleted_at IS NULL AND right(ja.url, length($1)) = $1`,
      [suffix],
    );
    const bookings: Array<{ customer_id: number; artisan_user_id: number }> =
      await this.dataSource.query(
        `SELECT b.customer_id, ap.user_id AS artisan_user_id
           FROM bookings b JOIN artisan_profiles ap ON ap.id = b.artisan_profile_id
          WHERE b.attachment_urls IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM jsonb_array_elements_text(b.attachment_urls) u
               WHERE right(u, length($1)) = $1
            )`,
        [suffix],
      );
    if (jobs.length === 0 && bookings.length === 0) return false;
    if (viewer.role === Role.ADMIN) return true;

    if (
      bookings.some(
        (b) => b.customer_id === viewer.id || b.artisan_user_id === viewer.id,
      )
    ) {
      return true;
    }
    for (const job of jobs) {
      if (job.customer_id === viewer.id) return true;
      if (viewer.role !== Role.ARTISAN) continue;
      if (job.status === 'OPEN' || job.accepted_artisan_id === viewer.id) {
        return true;
      }
      const [{ applied }]: Array<{ applied: boolean }> =
        await this.dataSource.query(
          `SELECT EXISTS (SELECT 1 FROM job_applications WHERE job_id = $1 AND artisan_id = $2) AS applied`,
          [job.id, viewer.id],
        );
      if (applied) return true;
    }
    return false;
  }

  /**
   * Local disk first (development, and files from before S3), then the
   * private bucket, then the old public key for files uploaded before these
   * folders became private.
   */
  private async read(
    folder: SharedPrivateUploadFolder,
    filename: string,
  ): Promise<PrivateMediaObject | null> {
    const fromDisk = await this.localProvider.readPrivate(folder, filename);
    if (fromDisk) return fromDisk;

    const active = this.factory.getProvider();
    if (active.providerName === this.localProvider.providerName) return null;

    const fromPrivate = await active.readPrivate(folder, filename);
    if (fromPrivate) return fromPrivate;

    const legacy = await this.s3Provider.readLegacyShared(folder, filename);
    if (legacy) {
      this.logger.warn(
        `Served ${folder}/${filename} from its pre-MSG-18 public location; it is still public at its old URL until moved to the private bucket.`,
      );
    }
    return legacy;
  }
}
