import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { plainToInstance } from 'class-transformer';
import { loadEsm } from 'load-esm';
import { Repository } from 'typeorm';
import { PortfolioItem } from './entities/portfolio-item.entity';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { StorageProviderFactory } from '../uploads/providers/storage-provider.factory';
import { CreatePortfolioItemDto } from './dto/create-portfolio-item.dto';
import { ResubmitPortfolioItemDto } from './dto/resubmit-portfolio-item.dto';
import { ReorderPortfolioItemDto } from './dto/reorder-portfolio-item.dto';
import { RejectPortfolioItemDto } from './dto/reject-portfolio-item.dto';
import { PortfolioItemResponseDto } from './dto/portfolio-item-response.dto';
import { AdminPortfolioQueueItemResponseDto } from './dto/admin-portfolio-queue-item-response.dto';
import { PortfolioStatus, Role } from '@common/types/enums';
import { APP_EVENTS } from '@common/events/app.events';
import type {
  PortfolioApprovedPayload,
  PortfolioRejectedPayload,
} from '@common/events/app.events';

const MB = 1024 * 1024;
const MAX_PORTFOLIO_FILE_BYTES = 50 * MB;
const ALLOWED_PORTFOLIO_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'video/mp4',
]);

type ItemResponse = { message: string; data: PortfolioItemResponseDto };
type ItemListResponse = { message: string; data: PortfolioItemResponseDto[] };
type QueueResponse = {
  message: string;
  data: AdminPortfolioQueueItemResponseDto[];
};

/** Minimal shape of `req.user`, used to decide caller-vs-owner visibility (PF3). */
export interface RequestingUser {
  id: number;
  role: Role;
}

@Injectable()
export class PortfolioService {
  private readonly logger = new Logger(PortfolioService.name);

  constructor(
    @InjectRepository(PortfolioItem)
    private readonly repo: Repository<PortfolioItem>,
    @InjectRepository(ArtisanProfile)
    private readonly profileRepo: Repository<ArtisanProfile>,
    private readonly storageFactory: StorageProviderFactory,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ─── Artisan-facing ──────────────────────────────────────────────────────────

  /**
   * PF2: uploads a new portfolio item for the authenticated artisan.
   * Always created as `PENDING`, awaiting admin moderation.
   */
  async create(
    userId: number,
    file: Express.Multer.File | undefined,
    dto: CreatePortfolioItemDto,
  ): Promise<ItemResponse> {
    const detectedMimeType = await this.assertValidFile(file);

    const profile = await this.profileRepo.findOne({
      where: { user: { id: userId } },
    });
    if (!profile) {
      throw new NotFoundException('Artisan profile not found.');
    }

    const provider = this.storageFactory.getProvider();
    const uploaded = await provider.upload(file!.buffer, {
      folder: 'portfolio',
      originalName: file!.originalname,
      mimetype: detectedMimeType,
    });

    const maxSortOrder = await this.repo
      .createQueryBuilder('p')
      .select('MAX(p.sortOrder)', 'max')
      .where('p.artisanId = :artisanId', { artisanId: profile.id })
      .getRawOne<{ max: string | null }>();
    const nextSortOrder = (Number(maxSortOrder?.max) || 0) + 1;

    const item = this.repo.create({
      artisanId: profile.id,
      fileUrl: uploaded.url,
      fileType: detectedMimeType,
      caption: dto.caption,
      tag: dto.tag,
      status: PortfolioStatus.PENDING,
      sortOrder: nextSortOrder,
    });

    const saved = await this.repo.save(item);
    this.logger.log(
      `Artisan profile ${profile.id} uploaded portfolio item ${saved.id}`,
    );

    return {
      message: 'Portfolio item uploaded and pending review.',
      data: this.toDto(saved),
    };
  }

  /**
   * PF3: returns an artisan's portfolio items. Customers and unauthenticated
   * callers only ever see `APPROVED` items; the owning artisan sees all
   * statuses (including PENDING/REJECTED, needed for PF7a resubmission).
   */
  async findByArtisan(
    artisanId: number,
    requester?: RequestingUser,
  ): Promise<ItemListResponse> {
    const profile = await this.profileRepo.findOne({
      where: { id: artisanId },
      relations: ['user'],
    });
    if (!profile) {
      throw new NotFoundException(
        `Artisan profile with id ${artisanId} not found.`,
      );
    }

    const isOwner =
      !!requester &&
      requester.role === Role.ARTISAN &&
      requester.id === profile.user.id;

    const qb = this.repo
      .createQueryBuilder('p')
      .where('p.artisanId = :artisanId', { artisanId })
      .orderBy('p.sortOrder', 'ASC')
      .addOrderBy('p.createdAt', 'DESC');

    if (!isOwner) {
      qb.andWhere('p.status = :status', { status: PortfolioStatus.APPROVED });
    }

    const items = await qb.getMany();

    return {
      message: 'Portfolio items retrieved.',
      data: items.map((item) => this.toDto(item)),
    };
  }

  /**
   * PF3: deletes the authenticated artisan's own portfolio item (DB record
   * and stored file). Ownership is enforced server-side — another artisan's
   * item, or a non-existent one, both resolve to a 404.
   */
  async remove(userId: number, id: number): Promise<{ message: string }> {
    const item = await this.loadOwnedOrFail(userId, id);

    await this.deleteStoredFile(item);
    await this.repo.delete(item.id);

    this.logger.log(`Portfolio item ${id} deleted by user ${userId}`);
    return { message: 'Portfolio item deleted.' };
  }

  /**
   * PF3/PF7: persists a new `sortOrder` for the authenticated artisan's own item.
   */
  async reorder(
    userId: number,
    id: number,
    dto: ReorderPortfolioItemDto,
  ): Promise<ItemResponse> {
    const item = await this.loadOwnedOrFail(userId, id);
    item.sortOrder = dto.sortOrder;
    await this.repo.save(item);
    return { message: 'Portfolio item reordered.', data: this.toDto(item) };
  }

  /**
   * PF7a (chosen design): dedicated `PATCH /portfolio/:id/resubmit`, accepting
   * a new file (required) and optionally updated caption/tag. Only valid for
   * an item currently `REJECTED`. Replaces the stored file, resets `status`
   * to `PENDING`, and clears the superseded `rejectionReason`.
   */
  async resubmit(
    userId: number,
    id: number,
    file: Express.Multer.File | undefined,
    dto: ResubmitPortfolioItemDto,
  ): Promise<ItemResponse> {
    const detectedMimeType = await this.assertValidFile(file);
    const item = await this.loadOwnedOrFail(userId, id);

    if (item.status !== PortfolioStatus.REJECTED) {
      throw new BadRequestException(
        'Only a rejected portfolio item can be resubmitted.',
      );
    }

    const provider = this.storageFactory.getProvider();
    const uploaded = await provider.upload(file!.buffer, {
      folder: 'portfolio',
      originalName: file!.originalname,
      mimetype: detectedMimeType,
    });

    const previousFileUrl = item.fileUrl;
    const previousFileType = item.fileType;

    item.fileUrl = uploaded.url;
    item.fileType = detectedMimeType;
    item.status = PortfolioStatus.PENDING;
    // Must be `null`, not `undefined`: TypeORM's save() omits properties set
    // to `undefined` from the generated UPDATE entirely, so the previous
    // (stale) rejection reason would otherwise survive in Postgres.
    item.rejectionReason = null;
    if (dto.tag !== undefined) item.tag = dto.tag;
    if (dto.caption !== undefined) item.caption = dto.caption;

    await this.repo.save(item);

    await this.deleteStoredFile({
      fileUrl: previousFileUrl,
      fileType: previousFileType,
    });

    this.logger.log(
      `Portfolio item ${id} resubmitted by user ${userId}; status reset to PENDING`,
    );
    return {
      message: 'Portfolio item resubmitted for review.',
      data: this.toDto(item),
    };
  }

  // ─── Admin moderation (PF4) ───────────────────────────────────────────────────

  async getQueue(): Promise<QueueResponse> {
    const items = await this.repo.find({
      where: { status: PortfolioStatus.PENDING },
      relations: ['artisanProfile', 'artisanProfile.user'],
      order: { createdAt: 'ASC' },
    });

    return {
      message: 'Moderation queue retrieved.',
      data: plainToInstance(AdminPortfolioQueueItemResponseDto, items, {
        excludeExtraneousValues: true,
      }),
    };
  }

  async approve(id: number): Promise<{ message: string }> {
    const item = await this.loadForModerationOrFail(id);
    if (item.status === PortfolioStatus.APPROVED) {
      throw new BadRequestException('This item is already approved.');
    }

    item.status = PortfolioStatus.APPROVED;
    // See the identical note in resubmit(): must be `null`, not `undefined`,
    // for TypeORM's save() to actually clear the column in Postgres.
    item.rejectionReason = null;
    await this.repo.save(item);

    this.eventEmitter.emit(APP_EVENTS.PORTFOLIO_APPROVED, {
      artisanUserId: item.artisanProfile.user.id,
      portfolioItemId: item.id,
    } as PortfolioApprovedPayload);

    return { message: 'Portfolio item approved. Artisan has been notified.' };
  }

  async reject(
    id: number,
    dto: RejectPortfolioItemDto,
  ): Promise<{ message: string }> {
    const item = await this.loadForModerationOrFail(id);
    if (item.status === PortfolioStatus.REJECTED) {
      throw new BadRequestException('This item is already rejected.');
    }

    item.status = PortfolioStatus.REJECTED;
    item.rejectionReason = dto.rejectionReason;
    await this.repo.save(item);

    this.eventEmitter.emit(APP_EVENTS.PORTFOLIO_REJECTED, {
      artisanUserId: item.artisanProfile.user.id,
      portfolioItemId: item.id,
      reason: dto.rejectionReason,
    } as PortfolioRejectedPayload);

    return { message: 'Portfolio item rejected. Artisan has been notified.' };
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Validates an uploaded file and returns its *sniffed* (magic-number
   * verified) MIME type — never the client-declared one.
   *
   * Security: the client-supplied multipart `Content-Type` header
   * (`file.mimetype`) is fully attacker-controlled — checking it alone
   * against an allow-list lets an attacker send e.g. `filename="x.html"`
   * with `Content-Type: image/jpeg` and arbitrary HTML/JS body, which would
   * previously pass validation. We additionally sniff the actual file bytes'
   * magic number (via `file-type`) and require the *detected* type to be on
   * the allow-list. The detected type — not the client's declared mimetype
   * or original filename — is what's returned here and subsequently used
   * for the stored `fileType` column and the storage provider's derived file
   * extension, so a spoofed declaration can no longer influence what gets
   * persisted or served.
   */
  private async assertValidFile(
    file: Express.Multer.File | undefined,
  ): Promise<string> {
    if (!file) {
      throw new BadRequestException('A file is required.');
    }
    if (file.size > MAX_PORTFOLIO_FILE_BYTES) {
      throw new BadRequestException('File exceeds the 50MB size limit.');
    }
    if (!ALLOWED_PORTFOLIO_TYPES.has(file.mimetype)) {
      throw new BadRequestException(
        'Unsupported file type. Only JPEG, PNG, and MP4 files are allowed.',
      );
    }

    const { fileTypeFromBuffer } =
      await loadEsm<typeof import('file-type')>('file-type');
    const detected = await fileTypeFromBuffer(file.buffer);
    if (!detected || !ALLOWED_PORTFOLIO_TYPES.has(detected.mime)) {
      throw new BadRequestException(
        'Unsupported file type. Only JPEG, PNG, and MP4 files are allowed.',
      );
    }
    return detected.mime;
  }

  private async loadOwnedOrFail(
    userId: number,
    id: number,
  ): Promise<PortfolioItem> {
    const item = await this.repo.findOne({
      where: { id, artisanProfile: { user: { id: userId } } },
      relations: ['artisanProfile', 'artisanProfile.user'],
    });
    // Ownership is folded into the lookup: a non-existent item and someone
    // else's item are indistinguishable to the caller (both 404).
    if (!item) {
      throw new NotFoundException(`Portfolio item ${id} not found.`);
    }
    return item;
  }

  private async loadForModerationOrFail(id: number): Promise<PortfolioItem> {
    const item = await this.repo.findOne({
      where: { id },
      relations: ['artisanProfile', 'artisanProfile.user'],
    });
    if (!item) {
      throw new NotFoundException(`Portfolio item ${id} not found.`);
    }
    return item;
  }

  private async deleteStoredFile(item: {
    fileUrl: string;
    fileType: string;
  }): Promise<void> {
    try {
      const filename = item.fileUrl.split('/').pop();
      if (!filename) return;
      const provider = this.storageFactory.getProvider();
      await provider.delete(filename, 'portfolio');
    } catch (err) {
      this.logger.warn(
        `Failed to delete stored file for ${item.fileUrl}: ${(err as Error).message}`,
      );
    }
  }

  private toDto(item: PortfolioItem): PortfolioItemResponseDto {
    return plainToInstance(PortfolioItemResponseDto, item, {
      excludeExtraneousValues: true,
    });
  }
}
