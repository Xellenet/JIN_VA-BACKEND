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
import { ArtisanPublicResponseDto } from './dto/artisan-public-response.dto';
import { GetArtisansQueryDto, ArtisanSortBy } from './dto/get-artisans-query.dto';
import { UpdateArtisanProfileDto } from '@users/dto/update-artisan-profile.dto';
import { ArtisanProfileResponseDto } from '@users/dto/artisan-profile-response.dto';
import { SUCCESS_MESSAGES } from '@common/constants/success-messages.constants';

type Pagination = { total: number; page: number; limit: number; totalPages: number };
type PublicList = { message: string; data: ArtisanPublicResponseDto[]; pagination: Pagination };
type PublicItem = { message: string; data: ArtisanPublicResponseDto };
type PrivateItem = { message: string; data: ArtisanProfileResponseDto };

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
    const page  = query.page  ?? 1;
    const limit = query.limit ?? 10;
    const skip  = (page - 1) * limit;

    const qb = this.buildSearchQb();
    this.applySearchFilters(qb, query);
    this.applySortOrder(qb, query.sortBy);

    const [profiles, total] = await qb.skip(skip).take(limit).getManyAndCount();

    return {
      message: SUCCESS_MESSAGES.ARTISAN_PROFILE.ALL_RETRIEVED,
      data: profiles.map(p => this.toPublic(p)),
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
      throw new NotFoundException(`Artisan profile with id ${artisanProfileId} not found.`);
    }

    return {
      message: SUCCESS_MESSAGES.ARTISAN_PROFILE.RETRIEVED,
      data: this.toPublic(profile),
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
  async updateMe(userId: number, dto: UpdateArtisanProfileDto): Promise<PrivateItem> {
    const { serviceIds, ...profileUpdates } = dto;

    const profile = await this.artisanProfileRepository.findOne({
      where: { user: { id: userId } },
      relations: ['user', 'user.addresses', 'services'],
    });

    if (!profile) {
      throw new NotFoundException(`Artisan profile for user ${userId} not found.`);
    }

    if (serviceIds !== undefined) {
      if (serviceIds.length === 0) {
        profile.services = [];
      } else {
        const services = await this.servicesRepository.findBy({ id: In(serviceIds) });
        if (services.length !== serviceIds.length) {
          throw new NotFoundException('One or more services were not found.');
        }
        profile.services = services;
      }
    }

    Object.assign(profile, profileUpdates);
    await this.artisanProfileRepository.save(profile);

    const updated = await this.artisanProfileRepository.findOne({
      where: { id: profile.id },
      relations: ['user', 'user.addresses', 'services'],
    });

    this.logger.log(`Artisan ${userId} updated their profile`);

    return {
      message: SUCCESS_MESSAGES.ARTISAN_PROFILE.UPDATED,
      data: plainToInstance(ArtisanProfileResponseDto, updated, { excludeExtraneousValues: true }),
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
      throw new NotFoundException(`Artisan profile for user ${userId} not found.`);
    }

    const service = await this.servicesRepository.findOne({ where: { id: serviceId } });
    if (!service) {
      throw new NotFoundException(`Service with id ${serviceId} not found.`);
    }

    const alreadyAdded = profile.services.some(s => s.id === serviceId);
    if (alreadyAdded) {
      throw new ConflictException(`Service "${service.name}" is already on your profile.`);
    }

    profile.services.push(service);
    await this.artisanProfileRepository.save(profile);

    const updated = await this.artisanProfileRepository.findOne({
      where: { id: profile.id },
      relations: ['user', 'user.addresses', 'services'],
    });

    this.logger.log(`Artisan ${userId} added service ${serviceId} to their profile`);

    return {
      message: SUCCESS_MESSAGES.ARTISAN_PROFILE.SERVICE_ADDED,
      data: plainToInstance(ArtisanProfileResponseDto, updated, { excludeExtraneousValues: true }),
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
      throw new NotFoundException(`Artisan profile for user ${userId} not found.`);
    }

    const index = profile.services.findIndex(s => s.id === serviceId);
    if (index === -1) {
      throw new BadRequestException(`Service with id ${serviceId} is not on your profile.`);
    }

    profile.services.splice(index, 1);
    await this.artisanProfileRepository.save(profile);

    const updated = await this.artisanProfileRepository.findOne({
      where: { id: profile.id },
      relations: ['user', 'user.addresses', 'services'],
    });

    this.logger.log(`Artisan ${userId} removed service ${serviceId} from their profile`);

    return {
      message: SUCCESS_MESSAGES.ARTISAN_PROFILE.SERVICE_REMOVED,
      data: plainToInstance(ArtisanProfileResponseDto, updated, { excludeExtraneousValues: true }),
    };
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  private buildSearchQb(): SelectQueryBuilder<ArtisanProfile> {
    return this.artisanProfileRepository
      .createQueryBuilder('ap')
      .innerJoinAndSelect('ap.user', 'user')
      .leftJoinAndSelect('ap.services', 'services')
      .where('user.deletedAt IS NULL');
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
      qb.andWhere('ap.averageRating >= :minRating', { minRating: query.minRating });
    }

    if (query.availabilityStatus) {
      qb.andWhere('ap.availabilityStatus = :availabilityStatus', {
        availabilityStatus: query.availabilityStatus,
      });
    }

    if (query.isVerified !== undefined) {
      qb.andWhere('ap.isVerified = :isVerified', { isVerified: query.isVerified });
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

  private toPublic(profile: ArtisanProfile): ArtisanPublicResponseDto {
    return plainToInstance(ArtisanPublicResponseDto, profile, {
      excludeExtraneousValues: true,
    });
  }
}
