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
import { VARIABLES } from '@common/constants/variables.constants';

@Injectable()
export class ServicesService {
  private readonly logger = new Logger(ServicesService.name);

  constructor(
    @InjectRepository(ServiceEntity)
    private readonly servicesRepository: Repository<ServiceEntity>,
  ) {}

  /**
   * Create a new service
   * @param createServiceDto 
   * @returns {Promise<ServiceResponseDto>}
   */
  async create(createServiceDto: CreateServiceDto): Promise<ServiceResponseDto> {
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
    return plainToInstance(ServiceResponseDto, {
        message: VARIABLES.SERVICE_CREATED,
        data: plainToInstance(ServiceEntity, saved),
        
    });
  }

  /**
   * Retrieve all services
   * @returns {Promise<ServiceResponseDto[]>}
   */
  async findAll(): Promise<ServiceResponseDto> {
    const services = await this.servicesRepository.find({
      order: { id: 'DESC' },
    });
    return plainToInstance(ServiceResponseDto, { 
        message: VARIABLES.ALL_SERVICES_RETRIEVED,
        data: plainToInstance(ServiceEntity, services),
    });
  }

  async findOne(id: number): Promise<ServiceResponseDto> {
    const service = await this.servicesRepository.findOne({
      where: { id },
    });

    if (!service) {
      throw new NotFoundException(`Service with id ${id} not found.`);
    }

    return plainToInstance(ServiceResponseDto, {
      message: VARIABLES.SERVICE_RETRIEVED,
      data: plainToInstance(ServiceEntity, service),
    });
  }

  async update(id: number, updateServiceDto: UpdateServiceDto): Promise<ServiceResponseDto> {
    const service = await this.findOne(id);

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
    await this.servicesRepository.save(service);

    this.logger.log(`Updated service with id: ${id}`);
    
    return plainToInstance( ServiceResponseDto, {
        message: VARIABLES.SERVICE_UPDATED,
        data: plainToInstance(ServiceEntity, service),
    });
  }

  async remove(id: number): Promise<{ message: string }> {
    await this.findOne(id);
    await this.servicesRepository.delete(id);

    this.logger.log(`Deleted service with id: ${id}`);
    return { message: 'Service deleted successfully' };
  }
}
