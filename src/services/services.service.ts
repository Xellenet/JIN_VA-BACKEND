import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ILike, Repository } from 'typeorm';
import { ServiceEntity } from './entities/service.entity';
import { CreateServiceDto } from './dto/create-service.dto';
import { UpdateServiceDto } from './dto/update-service.dto';
import { GetServicesQueryDto } from './dto/get-services-query.dto';
import { ServiceResponseDto } from './dto/service-response.dto';
import { plainToInstance } from 'class-transformer';
import { SUCCESS_MESSAGES } from '@common/constants/success-messages.constants';

/** How many records refer to a service (shown to admins, checked on delete). */
export type ServiceUsage = { artisans: number; bookings: number; jobs: number };

type Pagination = {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

@Injectable()
export class ServicesService {
  private readonly logger = new Logger(ServicesService.name);

  constructor(
    @InjectRepository(ServiceEntity)
    private readonly servicesRepository: Repository<ServiceEntity>,
  ) {}

  /**
   * Creates a new service offering.
   *
   * @param createServiceDto - Fields required to create the service.
   * @returns The created service wrapped in a `{ message, data }` response payload.
   * @throws {ConflictException} When a service with the same name, in any case, already exists.
   */
  async create(
    createServiceDto: CreateServiceDto,
  ): Promise<{ message: string; data: ServiceResponseDto }> {
    const existing = await this.findByNameIgnoringCase(createServiceDto.name);

    if (existing) throw duplicateName(existing.name);

    const service = this.servicesRepository.create({
      ...createServiceDto,
      ...(createServiceDto.description === ''
        ? { description: undefined }
        : {}),
    });
    const saved = await this.servicesRepository.save(service);
    this.logger.log(`Created service with id: ${saved.id}`);

    return {
      message: SUCCESS_MESSAGES.SERVICE.CREATED,
      data: plainToInstance(ServiceResponseDto, saved, {
        excludeExtraneousValues: true,
      }),
    };
  }

  /**
   * Returns a paginated list of services, optionally filtered by name.
   *
   * Hidden services are left out unless the caller is an admin who asked
   * for them (`includeInactive`); admins then also get each service's usage
   * counts, so the admin page can say why one can't be deleted.
   *
   * @param query   - Optional `search` (name substring), `page`, `limit` and `includeInactive`.
   * @param isAdmin - Whether the caller is an admin (from the optional JWT).
   * @returns `{ message, data, pagination }` response payload.
   */
  async findAll(
    query: GetServicesQueryDto,
    isAdmin = false,
  ): Promise<{
    message: string;
    data: Array<ServiceResponseDto & { usage?: ServiceUsage }>;
    pagination: Pagination;
  }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 100;
    const skip = (page - 1) * limit;
    const adminView = isAdmin && query.includeInactive === true;

    const where = {
      ...(query.search ? { name: ILike(`%${query.search}%`) } : {}),
      ...(adminView ? {} : { isActive: true }),
    };

    const [services, total] = await this.servicesRepository.findAndCount({
      where,
      order: { id: 'DESC' },
      skip,
      take: limit,
    });

    const data: Array<ServiceResponseDto & { usage?: ServiceUsage }> =
      plainToInstance(ServiceResponseDto, services, {
        excludeExtraneousValues: true,
      });
    if (adminView && data.length) {
      const usage = await this.usageOf(data.map((s) => s.id));
      for (const item of data) {
        item.usage = usage.get(item.id) ?? {
          artisans: 0,
          bookings: 0,
          jobs: 0,
        };
      }
    }

    return {
      message: SUCCESS_MESSAGES.SERVICE.ALL_RETRIEVED,
      data,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * Returns a single service by its ID.
   *
   * @param id - The service ID to look up.
   * @returns The matching service wrapped in a `{ message, data }` response payload.
   * @throws {NotFoundException} When no service with the given ID exists.
   */
  async findOne(
    id: number,
  ): Promise<{ message: string; data: ServiceResponseDto }> {
    const service = await this.servicesRepository.findOne({ where: { id } });

    if (!service) {
      throw new NotFoundException(`Service with id ${id} not found.`);
    }

    return {
      message: SUCCESS_MESSAGES.SERVICE.RETRIEVED,
      data: plainToInstance(ServiceResponseDto, service, {
        excludeExtraneousValues: true,
      }),
    };
  }

  /**
   * Applies a partial update to an existing service.
   * Validates that a renamed service does not clash with an existing name.
   *
   * @param id - The ID of the service to update.
   * @param updateServiceDto - Fields to update.
   * @returns The updated service wrapped in a `{ message, data }` response payload.
   * @throws {NotFoundException} When no service with the given ID exists.
   * @throws {ConflictException} When the new name is already taken by another service.
   */
  async update(
    id: number,
    updateServiceDto: UpdateServiceDto,
  ): Promise<{ message: string; data: ServiceResponseDto }> {
    const service = await this.servicesRepository.findOne({ where: { id } });

    if (!service) {
      throw new NotFoundException(`Service with id ${id} not found.`);
    }

    if (
      updateServiceDto.name &&
      updateServiceDto.name.toLowerCase() !== service.name.toLowerCase()
    ) {
      const existing = await this.findByNameIgnoringCase(
        updateServiceDto.name,
        id,
      );

      if (existing) throw duplicateName(existing.name);
    }

    Object.assign(service, updateServiceDto);
    // An emptied description clears it.
    if (updateServiceDto.description === '') service.description = null;
    const saved = await this.servicesRepository.save(service);
    this.logger.log(`Updated service with id: ${id}`);

    return {
      message: SUCCESS_MESSAGES.SERVICE.UPDATED,
      data: plainToInstance(ServiceResponseDto, saved, {
        excludeExtraneousValues: true,
      }),
    };
  }

  /**
   * Permanently deletes a service by its ID.
   *
   * @param id - The ID of the service to delete.
   * @returns A `{ message }` confirmation payload (no data).
   * @throws {NotFoundException} When no service with the given ID exists.
   */
  async remove(id: number): Promise<{ message: string }> {
    await this.findOne(id);

    // QA ADM-12: deleting a service in use either failed with a raw 500 (jobs
    // reference it), left bookings that could never be confirmed (their
    // service became NULL), or silently took it off every artisan offering
    // it. Refuse instead, and say what is using it.
    // Customers' preferred services are not counted: that link cascades and
    // only steers their suggestions, so removing it loses no record.
    const [usage]: ServiceUsage[] = await this.servicesRepository.manager.query(
      `SELECT
           (SELECT COUNT(*)::int FROM artisan_profile_services WHERE service_id = $1) AS artisans,
           (SELECT COUNT(*)::int FROM bookings WHERE service_id = $1) AS bookings,
           (SELECT COUNT(*)::int FROM jobs WHERE service_id = $1) AS jobs`,
      [id],
    );
    const uses = [
      usage.artisans &&
        plural(usage.artisans, 'artisan offers', 'artisans offer'),
      usage.bookings && plural(usage.bookings, 'booking uses', 'bookings use'),
      usage.jobs && plural(usage.jobs, 'job uses', 'jobs use'),
    ].filter(Boolean);
    if (uses.length) {
      throw new ConflictException(
        `This service can't be deleted because ${uses.join(', ')} it. ` +
          (usage.bookings || usage.jobs
            ? 'Services with booking or job history are kept so those records stay complete. Hide it instead: customers and artisans can no longer pick it, and existing records keep it.'
            : 'Hide it instead, so no one new can pick it, or ask those artisans to remove it from their profile first.'),
      );
    }

    await this.servicesRepository.delete(id);
    this.logger.log(`Deleted service with id: ${id}`);

    return { message: SUCCESS_MESSAGES.SERVICE.DELETED };
  }

  /** Usage counts for a page of services, keyed by service id. */
  private async usageOf(ids: number[]): Promise<Map<number, ServiceUsage>> {
    const rows: Array<ServiceUsage & { id: number }> =
      await this.servicesRepository.manager.query(
        `SELECT s.id,
           (SELECT COUNT(*)::int FROM artisan_profile_services x WHERE x.service_id = s.id) AS artisans,
           (SELECT COUNT(*)::int FROM bookings x WHERE x.service_id = s.id) AS bookings,
           (SELECT COUNT(*)::int FROM jobs x WHERE x.service_id = s.id) AS jobs
         FROM services s
         WHERE s.id = ANY($1)`,
        [ids],
      );
    return new Map(
      rows.map(({ id, artisans, bookings, jobs }) => [
        Number(id),
        { artisans, bookings, jobs },
      ]),
    );
  }

  /** QA ADM-10: names are unique regardless of case. */
  private findByNameIgnoringCase(
    name: string,
    exceptId?: number,
  ): Promise<ServiceEntity | null> {
    const qb = this.servicesRepository
      .createQueryBuilder('s')
      .where('LOWER(s.name) = LOWER(:name)', { name });
    if (exceptId != null) qb.andWhere('s.id <> :exceptId', { exceptId });
    return qb.getOne();
  }
}

/** QA ADM-10: a 409 naming the existing service, in its own spelling. */
function duplicateName(existing: string): ConflictException {
  return new ConflictException(
    `A service called "${existing}" already exists. Choose a different name, or edit that service instead.`,
  );
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}
