import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { plainToInstance } from 'class-transformer';
import { In, Repository, SelectQueryBuilder } from 'typeorm';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { User } from '@users/entities/user.entity';
import { ServiceEntity } from '@services/entities/service.entity';
import { Job } from '@jobs/entities/job.entity';
import { ArtisanPublicResponseDto } from './dto/artisan-public-response.dto';
import {
  GetArtisansQueryDto,
  ArtisanSortBy,
  AvailabilityWindow,
} from './dto/get-artisans-query.dto';
import { UpdateArtisanProfileDto } from '@users/dto/update-artisan-profile.dto';
import { ArtisanProfileResponseDto } from '@users/dto/artisan-profile-response.dto';
import { SUCCESS_MESSAGES } from '@common/constants/success-messages.constants';
import { Status } from '@common/types/enums';
type Pagination = {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};
type PublicList = {
  message: string;
  data: ArtisanPublicResponseDto[];
  pagination: Pagination;
};
type PublicItem = { message: string; data: ArtisanPublicResponseDto };
type PrivateItem = { message: string; data: ArtisanProfileResponseDto };

/**
 * F3: fields an artisan profile must have to be considered "complete enough"
 * to appear in customer-facing search. Resolves requirements.md open question
 * #2 — bio, an hourly rate, a service area, and at least one offered service
 * are the minimum a customer needs to evaluate and book the artisan.
 */
export function computeProfileCompleteness(
  profile: Pick<ArtisanProfile, 'bio' | 'hourlyRate' | 'location' | 'services'>,
): { isComplete: boolean; missingFields: string[] } {
  const missingFields: string[] = [];
  if (!profile.bio?.trim()) missingFields.push('bio');
  if (profile.hourlyRate === null || profile.hourlyRate === undefined)
    missingFields.push('hourlyRate');
  if (!profile.location?.trim()) missingFields.push('location');
  if (!profile.services || profile.services.length === 0)
    missingFields.push('services');
  return { isComplete: missingFields.length === 0, missingFields };
}

@Injectable()
export class ArtisansService {
  private readonly logger = new Logger(ArtisansService.name);

  constructor(
    @InjectRepository(ArtisanProfile)
    private readonly artisanProfileRepository: Repository<ArtisanProfile>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(ServiceEntity)
    private readonly servicesRepository: Repository<ServiceEntity>,
    @InjectRepository(Job)
    private readonly jobsRepository: Repository<Job>,
  ) {}

  // ─── Public discovery ────────────────────────────────────────────────────────

  /**
   * Searches artisan profiles with optional filters and pagination.
   *
   * Filters:
   * - `serviceId`          — only artisans who offer the given service category
   * - `keyword`            — partial, case-insensitive match on firstname, lastname, bio, or business name
   * - `location`           — partial, case-insensitive match on the artisan's location field
   * - `minRating`          — minimum average rating threshold
   * - `availabilityStatus` — AVAILABLE | BUSY | OFFLINE
   * - `isVerified`         — return only platform-verified artisans
   *
   * Sort options (via `sortBy`): rating (default), newest, experience, hourlyRate.
   *
   * @param query - Search, filter, sort, and pagination options.
   * @returns `{ message, data, pagination }`.
   */
  async search(query: GetArtisansQueryDto): Promise<PublicList> {
    const page = query.page ?? 1;
    // D6: default reconciled to 20/page to match the PRD (previously 10).
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const qb = this.buildSearchQb();
    this.applySearchFilters(qb, query);
    this.applySortOrder(qb, query.sortBy);

    // NOTE: intentionally not using qb.getManyAndCount() here. TypeORM's
    // getManyAndCount() has a "lazyCount" fast-path optimization that, when
    // fewer rows come back than the requested `take`, infers `total = skip +
    // entities.length` instead of issuing a real COUNT query. That inference
    // is wrong whenever the requested page is beyond the last real page
    // (e.g. 0 real matches, page > 1): it reports `total = skip` instead of
    // the true count. Cloning the qb before skip/take and calling
    // `.getCount()` on the clone always runs the real COUNT(DISTINCT ...)
    // query, sidestepping the shortcut entirely.
    const countQb = qb.clone();
    const [profiles, total] = await Promise.all([
      qb.skip(skip).take(limit).getMany(),
      countQb.getCount(),
    ]);

    // D3: bulk-compute completed-jobs counts for every profile on this page
    // in a single query, rather than N+1 queries per result card.
    const countsByUserId = await this.getCompletedJobsCountsByUserId(
      profiles.map((p) => p.user.id),
    );

    return {
      message: SUCCESS_MESSAGES.ARTISAN_PROFILE.ALL_RETRIEVED,
      data: profiles.map((p) =>
        this.toPublic(p, countsByUserId.get(p.user.id) ?? 0),
      ),
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * Returns the public profile of a single artisan by their artisan profile ID.
   *
   * @param artisanProfileId - The primary key of the artisan profile.
   * @returns `{ message, data: ArtisanPublicResponseDto }`.
   * @throws {NotFoundException} When no artisan profile with the given ID exists.
   */
  async findById(artisanProfileId: number): Promise<PublicItem> {
    const profile = await this.artisanProfileRepository.findOne({
      where: { id: artisanProfileId },
      relations: ['user', 'services'],
    });

    if (!profile) {
      throw new NotFoundException(
        `Artisan profile with id ${artisanProfileId} not found.`,
      );
    }

    // D3/P1: same completed-jobs count computation as search, for the Hero section.
    const completedJobsCount = await this.getCompletedJobsCount(
      profile.user.id,
    );

    return {
      message: SUCCESS_MESSAGES.ARTISAN_PROFILE.RETRIEVED,
      data: this.toPublic(profile, completedJobsCount),
    };
  }

  // ─── Authenticated artisan self-management ───────────────────────────────────

  /**
   * Partially updates the authenticated artisan's own profile.
   * Verified status, average rating, and total review count are not updatable here.
   *
   * @param userId - The authenticated artisan's user ID (from JWT).
   * @param dto    - Fields to update.
   * @returns `{ message, data: ArtisanProfileResponseDto }` with full profile.
   * @throws {NotFoundException} When the artisan profile or any requested service is not found.
   */
  async updateMe(
    userId: number,
    dto: UpdateArtisanProfileDto,
  ): Promise<PrivateItem> {
    const { serviceIds, ...profileUpdates } = dto;

    const profile = await this.artisanProfileRepository.findOne({
      where: { user: { id: userId } },
      relations: ['user', 'user.addresses', 'services'],
    });

    if (!profile) {
      throw new NotFoundException(
        `Artisan profile for user ${userId} not found.`,
      );
    }

    if (serviceIds !== undefined) {
      if (serviceIds.length === 0) {
        profile.services = [];
      } else {
        const services = await this.servicesRepository.findBy({
          id: In(serviceIds),
        });
        if (services.length !== serviceIds.length) {
          throw new NotFoundException('One or more services were not found.');
        }
        profile.services = services;
      }
    }

    Object.assign(profile, profileUpdates);

    // F3: recompute search-visibility eligibility on every profile edit — an
    // artisan who edits themselves into an incomplete state must drop out of
    // search immediately, not just be blocked from newly appearing.
    const { isComplete, missingFields } = computeProfileCompleteness(profile);
    profile.isProfileComplete = isComplete;

    await this.artisanProfileRepository.save(profile);

    const updated = await this.artisanProfileRepository.findOne({
      where: { id: profile.id },
      relations: ['user', 'user.addresses', 'services'],
    });

    this.logger.log(`Artisan ${userId} updated their profile`);

    return {
      message: SUCCESS_MESSAGES.ARTISAN_PROFILE.UPDATED,
      data: this.toPrivate(
        updated!,
        missingFields,
        await this.getCompletedJobsCount(userId),
      ),
    };
  }

  /**
   * Adds a single service to the authenticated artisan's offered services list.
   *
   * @param userId    - The authenticated artisan's user ID (from JWT).
   * @param serviceId - The service category ID to add.
   * @returns `{ message, data: ArtisanProfileResponseDto }`.
   * @throws {NotFoundException}  When the artisan profile or service is not found.
   * @throws {ConflictException}  When the service is already on the artisan's list.
   */
  async addService(userId: number, serviceId: number): Promise<PrivateItem> {
    const profile = await this.artisanProfileRepository.findOne({
      where: { user: { id: userId } },
      relations: ['user', 'user.addresses', 'services'],
    });

    if (!profile) {
      throw new NotFoundException(
        `Artisan profile for user ${userId} not found.`,
      );
    }

    const service = await this.servicesRepository.findOne({
      where: { id: serviceId },
    });
    if (!service) {
      throw new NotFoundException(`Service with id ${serviceId} not found.`);
    }

    const alreadyAdded = profile.services.some((s) => s.id === serviceId);
    if (alreadyAdded) {
      throw new ConflictException(
        `Service "${service.name}" is already on your profile.`,
      );
    }

    profile.services.push(service);

    const { isComplete, missingFields } = computeProfileCompleteness(profile);
    profile.isProfileComplete = isComplete;

    await this.artisanProfileRepository.save(profile);

    const updated = await this.artisanProfileRepository.findOne({
      where: { id: profile.id },
      relations: ['user', 'user.addresses', 'services'],
    });

    this.logger.log(
      `Artisan ${userId} added service ${serviceId} to their profile`,
    );

    return {
      message: SUCCESS_MESSAGES.ARTISAN_PROFILE.SERVICE_ADDED,
      data: this.toPrivate(
        updated!,
        missingFields,
        await this.getCompletedJobsCount(userId),
      ),
    };
  }

  /**
   * Removes a single service from the authenticated artisan's offered services list.
   *
   * @param userId    - The authenticated artisan's user ID (from JWT).
   * @param serviceId - The service category ID to remove.
   * @returns `{ message, data: ArtisanProfileResponseDto }`.
   * @throws {NotFoundException}  When the artisan profile or service is not found.
   * @throws {BadRequestException} When the service is not currently on the artisan's list.
   */
  async removeService(userId: number, serviceId: number): Promise<PrivateItem> {
    const profile = await this.artisanProfileRepository.findOne({
      where: { user: { id: userId } },
      relations: ['user', 'user.addresses', 'services'],
    });

    if (!profile) {
      throw new NotFoundException(
        `Artisan profile for user ${userId} not found.`,
      );
    }

    const index = profile.services.findIndex((s) => s.id === serviceId);
    if (index === -1) {
      throw new BadRequestException(
        `Service with id ${serviceId} is not on your profile.`,
      );
    }

    profile.services.splice(index, 1);

    const { isComplete, missingFields } = computeProfileCompleteness(profile);
    profile.isProfileComplete = isComplete;

    await this.artisanProfileRepository.save(profile);

    const updated = await this.artisanProfileRepository.findOne({
      where: { id: profile.id },
      relations: ['user', 'user.addresses', 'services'],
    });

    this.logger.log(
      `Artisan ${userId} removed service ${serviceId} from their profile`,
    );

    return {
      message: SUCCESS_MESSAGES.ARTISAN_PROFILE.SERVICE_REMOVED,
      data: this.toPrivate(
        updated!,
        missingFields,
        await this.getCompletedJobsCount(userId),
      ),
    };
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  private buildSearchQb(): SelectQueryBuilder<ArtisanProfile> {
    return (
      this.artisanProfileRepository
        .createQueryBuilder('ap')
        .innerJoinAndSelect('ap.user', 'user')
        .leftJoinAndSelect('ap.services', 'services')
        .where('user.deletedAt IS NULL')
        // F3: profiles missing required fields never appear in customer-facing search.
        .andWhere('ap.isProfileComplete = true')
    );
  }

  private applySearchFilters(
    qb: SelectQueryBuilder<ArtisanProfile>,
    query: GetArtisansQueryDto,
  ): void {
    if (query.serviceId !== undefined) {
      // Sub-select: artisans who have at least one matching service
      qb.andWhere(
        `EXISTS (
          SELECT 1 FROM artisan_profile_services aps
          WHERE aps.artisan_profile_id = ap.id
          AND aps.service_id = :serviceId
        )`,
        { serviceId: query.serviceId },
      );
    }

    if (query.keyword) {
      const kw = `%${query.keyword.toLowerCase()}%`;
      qb.andWhere(
        `(LOWER(user.firstname) LIKE :kw
          OR LOWER(user.lastname) LIKE :kw
          OR LOWER(ap.bio) LIKE :kw
          OR LOWER(ap.businessName) LIKE :kw)`,
        { kw },
      );
    }

    if (query.location) {
      qb.andWhere('LOWER(ap.location) LIKE :loc', {
        loc: `%${query.location.toLowerCase()}%`,
      });
    }

    if (query.minRating !== undefined) {
      qb.andWhere('ap.averageRating >= :minRating', {
        minRating: query.minRating,
      });
    }

    if (query.availabilityStatus) {
      qb.andWhere('ap.availabilityStatus = :availabilityStatus', {
        availabilityStatus: query.availabilityStatus,
      });
    }

    if (query.isVerified !== undefined) {
      qb.andWhere('ap.isVerified = :isVerified', {
        isVerified: query.isVerified,
      });
    }

    // D4: price-range filter against Service.price for any service the artisan offers.
    if (query.minPrice !== undefined || query.maxPrice !== undefined) {
      const priceConditions = [
        'aps2.artisan_profile_id = ap.id',
        'svc.price IS NOT NULL',
      ];
      const params: Record<string, number> = {};
      if (query.minPrice !== undefined) {
        priceConditions.push('svc.price >= :minPrice');
        params.minPrice = query.minPrice;
      }
      if (query.maxPrice !== undefined) {
        priceConditions.push('svc.price <= :maxPrice');
        params.maxPrice = query.maxPrice;
      }
      qb.andWhere(
        `EXISTS (
          SELECT 1 FROM artisan_profile_services aps2
          INNER JOIN services svc ON svc.id = aps2.service_id
          WHERE ${priceConditions.join(' AND ')}
        )`,
        params,
      );
    }

    // D7: best-effort "now" / "this week" availability filter, backed by real
    // ArtisanAvailability weekly-hours rows. Cannot account for already-booked/
    // blocked time — see AvailabilityWindow doc comment and api-contract.md.
    if (query.availabilityWindow === AvailabilityWindow.NOW) {
      const now = new Date();
      const dayOfWeek = now.getDay(); // 0 = Sunday, matches ArtisanAvailability.dayOfWeek
      const currentTime = now.toTimeString().slice(0, 8); // HH:MM:SS
      qb.andWhere(
        `EXISTS (
          SELECT 1 FROM artisan_availability av
          WHERE av.artisan_profile_id = ap.id
          AND av.is_active = true
          AND av.day_of_week = :availDayOfWeek
          AND av.start_time <= :availCurrentTime
          AND av.end_time > :availCurrentTime
        )`,
        { availDayOfWeek: dayOfWeek, availCurrentTime: currentTime },
      );
    } else if (query.availabilityWindow === AvailabilityWindow.THIS_WEEK) {
      // The stored schedule is a recurring weekly pattern (not date-specific),
      // so any active slot recurs within any 7-day window by definition.
      qb.andWhere(
        `EXISTS (
          SELECT 1 FROM artisan_availability av
          WHERE av.artisan_profile_id = ap.id
          AND av.is_active = true
        )`,
      );
    }
  }

  private applySortOrder(
    qb: SelectQueryBuilder<ArtisanProfile>,
    sortBy?: ArtisanSortBy,
  ): void {
    switch (sortBy) {
      case ArtisanSortBy.NEWEST:
        qb.orderBy('ap.createdAt', 'DESC');
        break;
      case ArtisanSortBy.EXPERIENCE:
        qb.orderBy('ap.experienceYears', 'DESC', 'NULLS LAST');
        break;
      case ArtisanSortBy.HOURLY_RATE:
        qb.orderBy('ap.hourlyRate', 'ASC', 'NULLS LAST');
        break;
      case ArtisanSortBy.RATING:
      default:
        qb.orderBy('ap.averageRating', 'DESC');
        break;
    }
  }

  private toPublic(
    profile: ArtisanProfile,
    completedJobsCount = 0,
  ): ArtisanPublicResponseDto {
    const dto = plainToInstance(ArtisanPublicResponseDto, profile, {
      excludeExtraneousValues: true,
    });
    dto.completedJobsCount = completedJobsCount;
    return dto;
  }

  /**
   * F3: builds the authenticated self-view DTO with `missingFields` attached.
   * `missingFields` isn't a persisted column (only the derived `isProfileComplete`
   * boolean is), so it's computed fresh and stitched onto the transformed DTO here
   * rather than sourced from the entity by `plainToInstance`.
   */
  private toPrivate(
    profile: ArtisanProfile,
    missingFields: string[],
    completedJobsCount = 0,
  ): ArtisanProfileResponseDto {
    const dto = plainToInstance(ArtisanProfileResponseDto, profile, {
      excludeExtraneousValues: true,
    });
    dto.completedJobsCount = completedJobsCount;
    dto.missingFields = missingFields;
    return dto;
  }

  /**
   * D3/P1: number of `Job` records completed by the given artisan (by user ID).
   */
  private async getCompletedJobsCount(userId: number): Promise<number> {
    return this.jobsRepository.count({
      where: { acceptedArtisan: { id: userId }, status: Status.COMPLETED },
    });
  }

  /**
   * D3: bulk variant of {@link getCompletedJobsCount} for a page of search
   * results — one grouped query instead of one query per result card.
   */
  private async getCompletedJobsCountsByUserId(
    userIds: number[],
  ): Promise<Map<number, number>> {
    const counts = new Map<number, number>();
    if (userIds.length === 0) return counts;

    // NOTE: `job.acceptedArtisanId` is a @RelationId() virtual property on
    // Job, not a real column — TypeORM can't translate it inside a raw
    // select/groupBy string, so Postgres receives the literal (invalid)
    // identifier and rejects the query. Join the real `acceptedArtisan`
    // relation and reference the joined alias's `id` instead, which TypeORM
    // correctly maps to the real `accepted_artisan_id` column.
    const rows = await this.jobsRepository
      .createQueryBuilder('job')
      .innerJoin('job.acceptedArtisan', 'acceptedArtisan')
      .select('acceptedArtisan.id', 'artisanUserId')
      .addSelect('COUNT(*)', 'count')
      .where('acceptedArtisan.id IN (:...userIds)', { userIds })
      .andWhere('job.status = :status', { status: Status.COMPLETED })
      .groupBy('acceptedArtisan.id')
      .getRawMany<{ artisanUserId: number; count: string }>();

    for (const row of rows) {
      counts.set(Number(row.artisanUserId), Number(row.count));
    }
    return counts;
  }
}
