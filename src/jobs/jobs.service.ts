import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { CreateJobDto } from './dto/create-job.dto';
import { UpdateJobDto } from './dto/update-job.dto';
import { JobResponseDto } from './dto/job-response.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { Job } from './entities/job.entity';
import { Repository } from 'typeorm';
import { plainToInstance } from 'class-transformer';
import { ServiceEntity } from '@services/entities/service.entity';
import { User } from '@users/entities/user.entity';


@Injectable()
export class JobsService {
  constructor(
    @InjectRepository(Job)
    private readonly jobsRepository: Repository<Job>,
    @InjectRepository(ServiceEntity)
    private readonly servicesRepository: Repository<ServiceEntity>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
  ) {}

  async create(createJobDto: CreateJobDto, user): Promise<JobResponseDto> {
    if( user.role !== 'customer') {
      throw new UnauthorizedException('Only customers can create jobs');
    }

    const customer = await this.usersRepository.findOne({
      where: { id: user.id },
    });
    if (!customer) {
      throw new NotFoundException('Authenticated customer not found.');
    }

    const service = await this.servicesRepository.findOne({
      where: { id: createJobDto.serviceId },
    });
    if (!service) {
      throw new NotFoundException('Selected service was not found.');
    }

    const { serviceId, ...jobPayload } = createJobDto;

    const job = this.jobsRepository.create({
      ...jobPayload,
      customer,
      service,
    });

    const saved = await this.jobsRepository.save(job);

    const savedWithRelations = await this.jobsRepository.findOne({
      where: { id: saved.id },
      relations: ['customer', 'service'],
    });

    return plainToInstance(JobResponseDto, {
      message: 'Job created successfully',
      data: savedWithRelations ?? saved,
    }, {
      excludeExtraneousValues: true,
    });
  }

  findAll() {
    return `This action returns all jobs`;
  }

  findOne(id: number) {
    return `This action returns a #${id} job`;
  }

  update(id: number, updateJobDto: UpdateJobDto) {
    return `This action updates a #${id} job`;
  }

  remove(id: number) {
    return `This action removes a #${id} job`;
  }

}
