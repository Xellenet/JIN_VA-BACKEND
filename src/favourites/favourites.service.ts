import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { plainToInstance } from 'class-transformer';
import { Repository } from 'typeorm';
import { Favourite } from './entities/favourite.entity';
import { GetFavouritesQueryDto } from './dto/get-favourites-query.dto';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { ArtisanPublicResponseDto } from '@artisans/dto/artisan-public-response.dto';
import { SUCCESS_MESSAGES } from '@common/constants/success-messages.constants';

type Pagination = { total: number; page: number; limit: number; totalPages: number };
type FavouriteList = { message: string; data: ArtisanPublicResponseDto[]; pagination: Pagination };

@Injectable()
export class FavouritesService {
  private readonly logger = new Logger(FavouritesService.name);

  constructor(
    @InjectRepository(Favourite)
    private readonly favouritesRepository: Repository<Favourite>,
    @InjectRepository(ArtisanProfile)
    private readonly artisanProfileRepository: Repository<ArtisanProfile>,
  ) {}

  /**
   * Saves an artisan to the authenticated customer's favourites list.
   *
   * @param customerId       - The authenticated customer's user ID (from JWT).
   * @param artisanProfileId - The artisan profile ID to save.
   * @returns Confirmation message.
   * @throws {NotFoundException}  When the artisan profile does not exist.
   * @throws {ConflictException}  When the artisan is already in the customer's favourites.
   */
  async add(customerId: number, artisanProfileId: number): Promise<{ message: string }> {
    const artisan = await this.artisanProfileRepository.findOne({
      where: { id: artisanProfileId },
    });

    if (!artisan) {
      throw new NotFoundException(`Artisan profile with id ${artisanProfileId} not found.`);
    }

    const existing = await this.favouritesRepository.findOne({
      where: {
        customer: { id: customerId },
        artisan: { id: artisanProfileId },
      },
    });

    if (existing) {
      throw new ConflictException('This artisan is already in your favourites.');
    }

    const favourite = this.favouritesRepository.create({
      customer: { id: customerId },
      artisan: { id: artisanProfileId },
    });

    await this.favouritesRepository.save(favourite);
    this.logger.log(`Customer ${customerId} added artisan profile ${artisanProfileId} to favourites`);

    return { message: SUCCESS_MESSAGES.FAVOURITE.ADDED };
  }

  /**
   * Removes an artisan from the authenticated customer's favourites list.
   *
   * @param customerId       - The authenticated customer's user ID (from JWT).
   * @param artisanProfileId - The artisan profile ID to remove.
   * @returns Confirmation message.
   * @throws {NotFoundException} When the artisan is not in the customer's favourites.
   */
  async remove(customerId: number, artisanProfileId: number): Promise<{ message: string }> {
    const favourite = await this.favouritesRepository.findOne({
      where: {
        customer: { id: customerId },
        artisan: { id: artisanProfileId },
      },
    });

    if (!favourite) {
      throw new NotFoundException('This artisan is not in your favourites.');
    }

    await this.favouritesRepository.delete(favourite.id);
    this.logger.log(`Customer ${customerId} removed artisan profile ${artisanProfileId} from favourites`);

    return { message: SUCCESS_MESSAGES.FAVOURITE.REMOVED };
  }

  /**
   * Returns the authenticated customer's paginated list of saved artisans.
   * Results are ordered by most recently saved first.
   *
   * @param customerId - The authenticated customer's user ID (from JWT).
   * @param query      - Pagination options.
   * @returns `{ message, data: ArtisanPublicResponseDto[], pagination }`.
   */
  async findAll(customerId: number, query: GetFavouritesQueryDto): Promise<FavouriteList> {
    const page  = query.page  ?? 1;
    const limit = query.limit ?? 10;
    const skip  = (page - 1) * limit;

    const [favourites, total] = await this.favouritesRepository
      .createQueryBuilder('fav')
      .innerJoinAndSelect('fav.artisan', 'artisan')
      .innerJoinAndSelect('artisan.user', 'user')
      .leftJoinAndSelect('artisan.services', 'services')
      .where('fav.customer = :customerId', { customerId })
      .andWhere('user.deletedAt IS NULL')
      .orderBy('fav.createdAt', 'DESC')
      .skip(skip)
      .take(limit)
      .getManyAndCount();

    const artisanProfiles = favourites.map(f =>
      plainToInstance(ArtisanPublicResponseDto, f.artisan, { excludeExtraneousValues: true }),
    );

    return {
      message: SUCCESS_MESSAGES.FAVOURITE.ALL_RETRIEVED,
      data: artisanProfiles,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }
}
