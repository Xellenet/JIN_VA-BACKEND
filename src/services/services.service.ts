import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ServiceEntity } from './entities/service.entity';
import { CreateServiceDto } from './dto/create-service.dto';
import { UpdateServiceDto } from './dto/update-service.dto';
import { ServiceResponseDto } from './dto/service-response.dto';
import { plainToInstance } from 'class-transformer';
import { SUCCESS_MESSAGES } from '@common/constants/success-messages.constants';

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
   * @throws {BadRequestException} When a service with the same name already exists.
   */
  async create(createServiceDto: CreateServiceDto): Promise<{ message: string; data: ServiceResponseDto }> {
    const existing = await this.servicesRepository.findOne({
      where: { name: createServiceDto.name },
    });

    if (existing) {
      throw new BadRequestException(
        `Service with name ${createServiceDto.name} already exists.`,
      );
    }

    const service = this.servicesRepository.create(createServiceDto);
    const saved = await this.servicesRepository.save(service);
    this.logger.log(`Created service with id: ${saved.id}`);

    return {
      message: SUCCESS_MESSAGES.SERVICE.CREATED,
      data: plainToInstance(ServiceResponseDto, saved, { excludeExtraneousValues: true }),
    };
  }

  /**
   * Returns all services ordered by most recently created.
   *
   * @returns All services wrapped in a `{ message, data }` response payload.
   */
  async findAll(): Promise<{ message: string; data: ServiceResponseDto[] }> {
    const services = await this.servicesRepository.find({
      order: { id: 'DESC' },
    });

    return {
      message: SUCCESS_MESSAGES.SERVICE.ALL_RETRIEVED,
      data: plainToInstance(ServiceResponseDto, services, { excludeExtraneousValues: true }),
    };
  }

  /**
   * Returns a single service by its ID.
   *
   * @param id - The service ID to look up.
   * @returns The matching service wrapped in a `{ message, data }` response payload.
   * @throws {NotFoundException} When no service with the given ID exists.
   */
  async findOne(id: number): Promise<{ message: string; data: ServiceResponseDto }> {
    const service = await this.servicesRepository.findOne({ where: { id } });

    if (!service) {
      throw new NotFoundException(`Service with id ${id} not found.`);
    }

    return {
      message: SUCCESS_MESSAGES.SERVICE.RETRIEVED,
      data: plainToInstance(ServiceResponseDto, service, { excludeExtraneousValues: true }),
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
   * @throws {BadRequestException} When the new name is already taken by another service.
   */
  async update(id: number, updateServiceDto: UpdateServiceDto): Promise<{ message: string; data: ServiceResponseDto }> {
    const service = await this.servicesRepository.findOne({ where: { id } });

    if (!service) {
      throw new NotFoundException(`Service with id ${id} not found.`);
    }

    if (updateServiceDto.name && updateServiceDto.name !== service.name) {
      const existing = await this.servicesRepository.findOne({
        where: { name: updateServiceDto.name },
      });

      if (existing) {
        throw new BadRequestException(
          `Service with name ${updateServiceDto.name} already exists.`,
        );
      }
    }

    Object.assign(service, updateServiceDto);
    const saved = await this.servicesRepository.save(service);
    this.logger.log(`Updated service with id: ${id}`);

    return {
      message: SUCCESS_MESSAGES.SERVICE.UPDATED,
      data: plainToInstance(ServiceResponseDto, saved, { excludeExtraneousValues: true }),
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
    await this.servicesRepository.delete(id);
    this.logger.log(`Deleted service with id: ${id}`);

    return { message: SUCCESS_MESSAGES.SERVICE.DELETED };
  }
}
