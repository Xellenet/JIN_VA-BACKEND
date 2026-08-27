import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { LocalStorageProvider } from './providers/local-storage.provider';
import { StorageProviderFactory } from './providers/storage-provider.factory';
import type { PrivateMediaObject } from './providers/storage-provider.interface';
import {
  isPrivateUploadFolder,
  isSafeMediaFilename,
  PRIVATE_UPLOAD_FOLDERS,
} from './upload-folders';

/**
 * Reads KYC media (identity documents and verification selfies) back for the
 * authenticated, admin-only endpoint.
 *
 * These two folders are the only upload folders that are *not* anonymously
 * readable in either storage mode: under S3 they live behind the `private/`
 * key prefix and no public URL is ever minted for them, and under local disk
 * `applyLegacyMediaServing` does not mount them, so `/uploads/documents/...`
 * falls through to Nest's clean JSON 404. This service is the one door.
 *
 * ── Which store holds the object ────────────────────────────────────────────
 * Local disk is tried **first, always**, and only then the active provider.
 * That is not an ordering accident: every document uploaded before the S3
 * cutover physically lives on the app server's disk, so an S3-only lookup
 * would 404 the entire existing verification backlog the moment
 * `STORAGE_PROVIDER=s3` was set. It is the same legacy-media problem BI2
 * solved for the public folders with a scoped static mount — except here the
 * fallback sits behind an admin guard instead of a public URL, so keeping it
 * costs nothing in exposure. It also means the two stores can never disagree
 * about a UUID (filenames are `randomUUID()`, so a collision is not a
 * practical concern).
 */
@Injectable()
export class KycMediaService {
  private readonly logger = new Logger(KycMediaService.name);

  constructor(
    private readonly factory: StorageProviderFactory,
    private readonly localProvider: LocalStorageProvider,
  ) {}

  /**
   * @param adminUserId the acting admin, recorded in the access log line —
   *   the finding this endpoint answers called out "no access audit trail" as
   *   part of the problem, so every read of a KYC object is attributable.
   */
  async open(
    folder: string,
    filename: string,
    adminUserId: number,
  ): Promise<PrivateMediaObject> {
    if (!isPrivateUploadFolder(folder)) {
      throw new BadRequestException(
        `Unknown KYC media folder. Expected one of: ${PRIVATE_UPLOAD_FOLDERS.join(', ')}.`,
      );
    }
    if (!isSafeMediaFilename(filename)) {
      throw new BadRequestException('Invalid KYC media filename.');
    }

    const fromDisk = await this.localProvider.readPrivate(folder, filename);
    if (fromDisk) {
      this.logger.log(
        `Admin #${adminUserId} read KYC object ${folder}/${filename} (local disk)`,
      );
      return fromDisk;
    }

    const active = this.factory.getProvider();
    if (active.providerName !== this.localProvider.providerName) {
      const fromActive = await active.readPrivate(folder, filename);
      if (fromActive) {
        this.logger.log(
          `Admin #${adminUserId} read KYC object ${folder}/${filename} (${active.providerName})`,
        );
        return fromActive;
      }
    }

    // Same message for "no such object" and "wrong folder for this object", so
    // the endpoint never confirms the existence of a KYC file to anyone.
    throw new NotFoundException(
      'That verification file is no longer available.',
    );
  }
}
