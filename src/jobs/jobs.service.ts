import { Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Job } from './entities/job.entity';
import { CreateJobDto } from './dto/create-job.dto';
import { UpdateJobDto } from './dto/update-job.dto';
import { ServiceEntity } from '@services/entities/service.entity';
import { User } from '@users/entities/user.entity';
import { Role } from '@common/types/enums';
import { SUCCESS_MESSAGES } from '@common/constants/success-messages.constants';

@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);

  constructor(
    @InjectRepository(Job)
    private readonly jobsRepository: Repository<Job>,
    @InjectRepository(ServiceEntity)
    private readonly servicesRepository: Repository<ServiceEntity>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
  ) {}

  /**
   * Creates a new job posting. Only users with the CUSTOMER role may post jobs.
   *
   * @param createJobDto - Fields required to create the job.
   * @param requestUser - The authenticated user object from `req.user` (JWT payload).
   * @returns `{ message, data: Job }` with customer and service relations populated.
   * @throws {UnauthorizedException} When the caller is not a customer.
   * @throws {NotFoundException} When the authenticated user or the selected service is not found.
   */
  async create(
    createJobDto: CreateJobDto,
    requestUser: { id: number; role: Role },
  ): Promise<{ message: string; data: Job }> {
    if (requestUser.role !== Role.CUSTOMER) {
      throw new UnauthorizedException('Only customers can create jobs');
    }

    const customer = await this.usersRepository.findOne({
      where: { id: requestUser.id },
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

    const { serviceId: _serviceId, ...jobPayload } = createJobDto;

    const job = this.jobsRepository.create({ ...jobPayload, customer, service });
    const saved = await this.jobsRepository.save(job);

    const populated = await this.jobsRepository.findOne({
      where: { id: saved.id },
      relations: ['customer', 'service'],
    });

    this.logger.log(`Created job with id: ${saved.id} for customer id: ${customer.id}`);

    return { message: SUCCESS_MESSAGES.JOB.CREATED, data: populated ?? saved };
  }

  findAll() {
    return `This action returns all jobs`;
  }

  findOne(id: number) {
    return `This action returns a #${id} job`;
  }

  update(id: number, _updateJobDto: UpdateJobDto) {
    return `This action updates a #${id} job`;
  }

  remove(id: number) {
    return `This action removes a #${id} job`;
  }
}
