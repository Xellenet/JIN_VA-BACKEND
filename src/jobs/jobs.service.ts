import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { plainToInstance } from 'class-transformer';
import { Repository } from 'typeorm';
import { Job } from './entities/job.entity';
import { JobApplication } from './entities/job-application.entity';
import { CreateJobDto } from './dto/create-job.dto';
import { UpdateJobDto } from './dto/update-job.dto';
import { GetJobsQueryDto } from './dto/get-jobs-query.dto';
import { JobResponseDto } from './dto/job-response.dto';
import { CreateApplicationDto } from './dto/create-application.dto';
import { ApplicationResponseDto } from './dto/application-response.dto';
import { ServiceEntity } from '@services/entities/service.entity';
import { User } from '@users/entities/user.entity';
import { ApplicationStatus, Role, Status } from '@common/types/enums';
import { SUCCESS_MESSAGES } from '@common/constants/success-messages.constants';
import { PaymentsService } from '../payments/payments.service';
import {
  APP_EVENTS,
  JobApplicationAcceptedPayload,
  JobApplicationReceivedPayload,
  JobCancelledPayload,
  JobCompletedPayload,
  JobCompletionRequestedPayload,
  JobStartedPayload,
} from '@common/events/app.events';

const IMMUTABLE_STATUSES = new Set([Status.COMPLETED, Status.CANCELLED, Status.EXPIRED]);

type Pagination = { total: number; page: number; limit: number; totalPages: number };
type JobList    = { message: string; data: JobResponseDto[]; pagination: Pagination };
type JobItem    = { message: string; data: JobResponseDto };
type AppItem    = { message: string; data: ApplicationResponseDto };
type AppList    = { message: string; data: ApplicationResponseDto[] };

@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);

  constructor(
    @InjectRepository(Job)
    private readonly jobsRepository: Repository<Job>,
    @InjectRepository(JobApplication)
    private readonly applicationsRepository: Repository<JobApplication>,
    @InjectRepository(ServiceEntity)
    private readonly servicesRepository: Repository<ServiceEntity>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    private readonly paymentsService: PaymentsService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ─── Job CRUD ────────────────────────────────────────────────────────────────

  /**
   * Creates a new job posting. Only users with the CUSTOMER role may post jobs.
   *
   * @param createJobDto - Fields required to create the job.
   * @param requestUser  - Authenticated user from the JWT payload.
   * @returns The created job with customer and service populated.
   * @throws {ForbiddenException} When the caller is not a CUSTOMER.
   * @throws {NotFoundException} When the selected service does not exist.
   * @throws {BadRequestException} When `budgetMax` < `budgetMin`.
   */
  async create(
    createJobDto: CreateJobDto,
    requestUser: { id: number; role: Role },
  ): Promise<JobItem> {
    if (requestUser.role !== Role.CUSTOMER) {
      throw new ForbiddenException('Only customers can post jobs.');
    }

    this.assertBudget(createJobDto.budgetMin, createJobDto.budgetMax);

    const customer = await this.usersRepository.findOne({ where: { id: requestUser.id } });
    if (!customer) throw new NotFoundException('Authenticated customer not found.');

    const service = await this.servicesRepository.findOne({ where: { id: createJobDto.serviceId } });
    if (!service) throw new NotFoundException(`Service with id ${createJobDto.serviceId} not found.`);

    const { serviceId: _sid, ...payload } = createJobDto;
    const saved = await this.jobsRepository.save(
      this.jobsRepository.create({ ...payload, customer, service }),
    );

    this.logger.log(`Job ${saved.id} created by customer ${customer.id}`);
    return { message: SUCCESS_MESSAGES.JOB.CREATED, data: await this.loadJobDto(saved.id) };
  }

  /**
   * Updates an existing job's content fields.
   * Only the owner may edit, and only while the job is OPEN or PENDING.
   * Service category and status cannot be changed here.
   *
   * @param id            - The job ID.
   * @param updateJobDto  - Partial set of updatable fields.
   * @param requestUserId - Authenticated caller's user ID.
   * @returns The updated job.
   * @throws {NotFoundException}   When no job with the given ID exists.
   * @throws {ForbiddenException}  When the caller is not the job owner.
   * @throws {BadRequestException} When the job is in an immutable state, or budget is invalid.
   */
  async update(id: number, updateJobDto: UpdateJobDto, requestUserId: number): Promise<JobItem> {
    const job = await this.loadJobOrFail(id);
    this.assertOwner(job, requestUserId);
    this.assertMutable(job);

    const nextMin = updateJobDto.budgetMin ?? (job.budgetMin as number | undefined);
    const nextMax = updateJobDto.budgetMax ?? (job.budgetMax as number | undefined);
    this.assertBudget(nextMin, nextMax);

    Object.assign(job, updateJobDto);
    await this.jobsRepository.save(job);

    this.logger.log(`Job ${id} updated by customer ${requestUserId}`);
    return { message: SUCCESS_MESSAGES.JOB.UPDATED, data: await this.loadJobDto(id) };
  }

  /**
   * Soft-deletes a job. Only the owner may delete, and only while the job is OPEN
   * (no artisan has been engaged yet).
   *
   * @param id            - The job ID.
   * @param requestUserId - Authenticated caller's user ID.
   * @throws {NotFoundException}   When no job with the given ID exists.
   * @throws {ForbiddenException}  When the caller is not the job owner.
   * @throws {BadRequestException} When the job is not OPEN.
   */
  async remove(id: number, requestUserId: number): Promise<{ message: string }> {
    const job = await this.loadJobOrFail(id);
    this.assertOwner(job, requestUserId);

    if (job.status !== Status.OPEN) {
      throw new BadRequestException(
        `Only OPEN jobs can be deleted. This job is currently ${job.status}.`,
      );
    }

    await this.jobsRepository.softDelete(id);
    this.logger.log(`Job ${id} soft-deleted by customer ${requestUserId}`);
    return { message: SUCCESS_MESSAGES.JOB.DELETED };
  }

  // ─── Read ────────────────────────────────────────────────────────────────────

  /**
   * Returns a paginated, filtered list of all non-deleted jobs.
   *
   * @param query - Optional `status`, `serviceId`, `location` filters + `page`/`limit`.
   */
  async findAll(query: GetJobsQueryDto): Promise<JobList> {
    const { page = 1, limit = 10 } = query;

    const qb = this.buildJobsQb();
    this.applyJobFilters(qb, query);

    const total = await qb.getCount();
    const jobs  = await qb.skip((page - 1) * limit).take(limit).getMany();

    return {
      message:    SUCCESS_MESSAGES.JOB.ALL_RETRIEVED,
      data:       plainToInstance(JobResponseDto, jobs, { excludeExtraneousValues: true }),
      pagination: this.paginate(total, page, limit),
    };
  }

  /**
   * Returns a paginated list of jobs belonging to the authenticated customer.
   * The caller's ID is used as an implicit filter so customers cannot query another's jobs.
   *
   * @param customerId - Authenticated caller's user ID.
   * @param query      - Optional filters + pagination.
   */
  async findMine(customerId: number, query: GetJobsQueryDto): Promise<JobList> {
    const { page = 1, limit = 10 } = query;

    const qb = this.buildJobsQb();
    qb.where('job.customer = :customerId', { customerId });
    this.applyJobFilters(qb, query);

    const total = await qb.getCount();
    const jobs  = await qb.skip((page - 1) * limit).take(limit).getMany();

    return {
      message:    SUCCESS_MESSAGES.JOB.ALL_RETRIEVED,
      data:       plainToInstance(JobResponseDto, jobs, { excludeExtraneousValues: true }),
      pagination: this.paginate(total, page, limit),
    };
  }

  /**
   * Returns a single job by its ID with customer and service populated.
   *
   * @param id - The job ID.
   * @throws {NotFoundException} When no non-deleted job with the given ID exists.
   */
  async findOne(id: number): Promise<JobItem> {
    return {
      message: SUCCESS_MESSAGES.JOB.RETRIEVED,
      data:    await this.loadJobDto(id),
    };
  }

  // ─── Application flow ────────────────────────────────────────────────────────

  /**
   * Submits an artisan's application to an OPEN job.
   * Each artisan may apply to a given job only once.
   *
   * @param jobId     - The job to apply for.
   * @param artisanId - Authenticated artisan's user ID.
   * @param dto       - Optional quote price and cover message.
   * @returns The created application.
   * @throws {NotFoundException}   When the job does not exist.
   * @throws {BadRequestException} When the job is not OPEN.
   * @throws {ConflictException}   When the artisan has already applied to this job.
   */
  async applyToJob(
    jobId: number,
    artisanId: number,
    dto: CreateApplicationDto,
  ): Promise<AppItem> {
    const job = await this.loadJobOrFail(jobId);

    if (job.status !== Status.OPEN) {
      throw new BadRequestException(
        `Applications can only be submitted to OPEN jobs. This job is ${job.status}.`,
      );
    }

    const existing = await this.applicationsRepository.findOne({
      where: { job: { id: jobId }, artisan: { id: artisanId } },
    });
    if (existing) {
      throw new ConflictException('You have already applied to this job.');
    }

    const artisan = await this.usersRepository.findOne({ where: { id: artisanId } });
    if (!artisan) throw new NotFoundException('Authenticated artisan not found.');

    const application = await this.applicationsRepository.save(
      this.applicationsRepository.create({ job, artisan, ...dto }),
    );

    this.logger.log(`Artisan ${artisanId} applied to job ${jobId} (application ${application.id})`);

    this.eventEmitter.emit(APP_EVENTS.JOB_APPLICATION_RECEIVED, {
      customerId:  job.customer.id,
      artisanName: `${artisan.firstname} ${artisan.lastname}`,
      jobTitle:    job.title ?? `Job #${job.id}`,
      jobId:       job.id,
    } as JobApplicationReceivedPayload);

    const populated = await this.applicationsRepository.findOne({
      where: { id: application.id },
      relations: ['artisan'],
    });

    return {
      message: SUCCESS_MESSAGES.JOB.APPLICATION_SUBMITTED,
      data:    plainToInstance(ApplicationResponseDto, populated, { excludeExtraneousValues: true }),
    };
  }

  /**
   * Returns all applications for a job. Only the job's owner (customer) may call this.
   *
   * @param jobId      - The job whose applications to list.
   * @param customerId - Authenticated caller's user ID; used for ownership check.
   * @throws {NotFoundException}  When the job does not exist.
   * @throws {ForbiddenException} When the caller does not own the job.
   */
  async getApplications(jobId: number, customerId: number): Promise<AppList> {
    const job = await this.loadJobOrFail(jobId);
    this.assertOwner(job, customerId);

    const applications = await this.applicationsRepository.find({
      where: { job: { id: jobId } },
      relations: ['artisan'],
      order: { createdAt: 'ASC' },
    });

    return {
      message: SUCCESS_MESSAGES.JOB.APPLICATIONS_RETRIEVED,
      data:    plainToInstance(ApplicationResponseDto, applications, { excludeExtraneousValues: true }),
    };
  }

  /**
   * Accepts one application. Automatically rejects all other applicants, sets the
   * job status to PENDING, and places a mock payment hold.
   *
   * @param jobId       - The job ID.
   * @param appId       - The application to accept.
   * @param customerId  - Authenticated caller's user ID; used for ownership check.
   * @returns The updated job.
   * @throws {NotFoundException}   When the job or application does not exist.
   * @throws {ForbiddenException}  When the caller does not own the job.
   * @throws {BadRequestException} When the job is not OPEN, or the application is not PENDING.
   */
  async acceptApplication(jobId: number, appId: number, customerId: number): Promise<JobItem> {
    const job = await this.loadJobOrFail(jobId);
    this.assertOwner(job, customerId);

    if (job.status !== Status.OPEN) {
      throw new BadRequestException(
        `An application can only be accepted on OPEN jobs. This job is ${job.status}.`,
      );
    }

    const application = await this.applicationsRepository.findOne({
      where: { id: appId, job: { id: jobId } },
      relations: ['artisan'],
    });
    if (!application) {
      throw new NotFoundException(`Application ${appId} not found for job ${jobId}.`);
    }
    if (application.status !== ApplicationStatus.PENDING) {
      throw new BadRequestException(
        `Only PENDING applications can be accepted. This application is ${application.status}.`,
      );
    }

    // Hold payment before committing any DB changes so a payment failure leaves the job OPEN.
    const intentId = await this.paymentsService.holdPayment(
      jobId,
      customerId,
      application.quotePrice as number | undefined,
    );

    // Accept the chosen application.
    application.status = ApplicationStatus.ACCEPTED;
    await this.applicationsRepository.save(application);

    // Reject all other PENDING applications.
    await this.applicationsRepository
      .createQueryBuilder()
      .update(JobApplication)
      .set({ status: ApplicationStatus.REJECTED })
      .where('job_id = :jobId AND id != :appId AND status = :status', {
        jobId,
        appId,
        status: ApplicationStatus.PENDING,
      })
      .execute();

    // Advance job to PENDING with the accepted artisan and payment intent stored.
    job.status             = Status.PENDING;
    job.acceptedArtisan    = application.artisan;
    job.paymentIntentId    = intentId;
    await this.jobsRepository.save(job);

    this.logger.log(
      `Job ${jobId} → PENDING. Accepted artisan ${application.artisanId}. Intent: ${intentId}`,
    );

    this.eventEmitter.emit(APP_EVENTS.JOB_APPLICATION_ACCEPTED, {
      artisanId: application.artisan.id,
      jobTitle:  job.title ?? `Job #${job.id}`,
      jobId:     job.id,
    } as JobApplicationAcceptedPayload);

    return { message: SUCCESS_MESSAGES.JOB.APPLICATION_ACCEPTED, data: await this.loadJobDto(jobId) };
  }

  // ─── State transitions ───────────────────────────────────────────────────────

  /**
   * Advances a PENDING job to IN_PROGRESS. Only the accepted artisan may call this.
   *
   * @param jobId     - The job ID.
   * @param artisanId - Authenticated artisan's user ID.
   * @returns The updated job.
   * @throws {NotFoundException}   When the job does not exist.
   * @throws {ForbiddenException}  When the caller is not the accepted artisan.
   * @throws {BadRequestException} When the job is not PENDING.
   */
  async startJob(jobId: number, artisanId: number): Promise<JobItem> {
    const job = await this.loadJobOrFail(jobId);

    if (job.status !== Status.PENDING) {
      throw new BadRequestException(
        `Only PENDING jobs can be started. This job is ${job.status}.`,
      );
    }

    this.assertAcceptedArtisan(job, artisanId);

    job.status = Status.IN_PROGRESS;
    await this.jobsRepository.save(job);

    this.logger.log(`Job ${jobId} → IN_PROGRESS by artisan ${artisanId}`);

    this.eventEmitter.emit(APP_EVENTS.JOB_STARTED, {
      customerId: job.customer.id,
      jobTitle:   job.title ?? `Job #${job.id}`,
      jobId:      job.id,
    } as JobStartedPayload);

    return { message: SUCCESS_MESSAGES.JOB.STARTED, data: await this.loadJobDto(jobId) };
  }

  /**
   * Signals that an artisan has finished the work and is requesting customer confirmation.
   * The job stays IN_PROGRESS — the customer must call {@link confirmCompletion} to finalise.
   * Sets `completionRequestedAt` on the job so the customer knows the request was received.
   *
   * @param jobId     - The job ID.
   * @param artisanId - Authenticated artisan's user ID.
   * @returns The updated job.
   * @throws {NotFoundException}   When the job does not exist.
   * @throws {ForbiddenException}  When the caller is not the accepted artisan.
   * @throws {BadRequestException} When the job is not IN_PROGRESS or was already requested.
   */
  async requestCompletion(jobId: number, artisanId: number): Promise<JobItem> {
    const job = await this.loadJobOrFail(jobId);

    if (job.status !== Status.IN_PROGRESS) {
      throw new BadRequestException(
        `Completion can only be requested on IN_PROGRESS jobs. This job is ${job.status}.`,
      );
    }

    this.assertAcceptedArtisan(job, artisanId);

    if (job.completionRequestedAt) {
      throw new BadRequestException('Completion has already been requested for this job.');
    }

    job.completionRequestedAt = new Date();
    await this.jobsRepository.save(job);

    this.logger.log(`Job ${jobId} — completion requested by artisan ${artisanId}`);

    this.eventEmitter.emit(APP_EVENTS.JOB_COMPLETION_REQUESTED, {
      customerId: job.customer.id,
      jobTitle:   job.title ?? `Job #${job.id}`,
      jobId:      job.id,
    } as JobCompletionRequestedPayload);

    return { message: SUCCESS_MESSAGES.JOB.COMPLETION_REQUESTED, data: await this.loadJobDto(jobId) };
  }

  /**
   * Customer confirms the work is done. Advances job to COMPLETED and captures the payment.
   * Can only be called after the artisan has called {@link requestCompletion}.
   *
   * @param jobId      - The job ID.
   * @param customerId - Authenticated customer's user ID.
   * @returns The completed job.
   * @throws {NotFoundException}   When the job does not exist.
   * @throws {ForbiddenException}  When the caller does not own the job.
   * @throws {BadRequestException} When the job is not IN_PROGRESS, or the artisan hasn't
   *                               signalled completion yet.
   */
  async confirmCompletion(jobId: number, customerId: number): Promise<JobItem> {
    const job = await this.loadJobOrFail(jobId);
    this.assertOwner(job, customerId);

    if (job.status !== Status.IN_PROGRESS) {
      throw new BadRequestException(
        `Only IN_PROGRESS jobs can be confirmed. This job is ${job.status}.`,
      );
    }

    if (!job.completionRequestedAt) {
      throw new BadRequestException(
        'The artisan has not yet signalled completion. Wait for a completion request before confirming.',
      );
    }

    if (job.paymentIntentId) {
      await this.paymentsService.capturePayment(job.paymentIntentId, jobId);
    }

    job.status = Status.COMPLETED;
    await this.jobsRepository.save(job);

    this.logger.log(`Job ${jobId} → COMPLETED. Payment captured. Customer ${customerId}`);

    if (job.acceptedArtisanId) {
      this.eventEmitter.emit(APP_EVENTS.JOB_COMPLETED, {
        artisanId: job.acceptedArtisanId,
        jobTitle:  job.title ?? `Job #${job.id}`,
        jobId:     job.id,
      } as JobCompletedPayload);
    }

    return { message: SUCCESS_MESSAGES.JOB.CONFIRMED, data: await this.loadJobDto(jobId) };
  }

  /**
   * Cancels a job. Available to the customer as long as the job is not already
   * COMPLETED or CANCELLED. If a payment hold exists (PENDING or IN_PROGRESS),
   * the hold is cancelled (full refund).
   *
   * @param jobId      - The job ID.
   * @param customerId - Authenticated customer's user ID.
   * @returns Confirmation message.
   * @throws {NotFoundException}   When the job does not exist.
   * @throws {ForbiddenException}  When the caller does not own the job.
   * @throws {BadRequestException} When the job cannot be cancelled.
   */
  async cancelJob(jobId: number, customerId: number): Promise<{ message: string }> {
    const job = await this.loadJobOrFail(jobId);
    this.assertOwner(job, customerId);

    if (job.status === Status.COMPLETED || job.status === Status.CANCELLED) {
      throw new BadRequestException(
        `A ${job.status} job cannot be cancelled.`,
      );
    }

    if (job.status === Status.EXPIRED) {
      throw new BadRequestException('An expired job cannot be cancelled.');
    }

    // Release the payment hold if one exists.
    if (job.paymentIntentId) {
      await this.paymentsService.cancelPayment(job.paymentIntentId, jobId);
      job.paymentIntentId = undefined;
    }

    job.status = Status.CANCELLED;
    await this.jobsRepository.save(job);

    this.logger.log(`Job ${jobId} → CANCELLED by customer ${customerId}`);

    if (job.acceptedArtisanId) {
      this.eventEmitter.emit(APP_EVENTS.JOB_CANCELLED, {
        artisanId: job.acceptedArtisanId,
        jobTitle:  job.title ?? `Job #${job.id}`,
        jobId:     job.id,
      } as JobCancelledPayload);
    }

    return { message: SUCCESS_MESSAGES.JOB.CANCELLED };
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  private buildJobsQb() {
    return this.jobsRepository
      .createQueryBuilder('job')
      .leftJoinAndSelect('job.customer', 'customer')
      .leftJoinAndSelect('job.service', 'service')
      .orderBy('job.createdAt', 'DESC');
  }

  private applyJobFilters(qb: ReturnType<typeof this.buildJobsQb>, query: GetJobsQueryDto) {
    if (query.status)    qb.andWhere('job.status = :status',        { status: query.status });
    if (query.serviceId) qb.andWhere('job.service = :serviceId',   { serviceId: query.serviceId });
    if (query.location) {
      qb.andWhere('LOWER(job.location) LIKE :loc', { loc: `%${query.location.toLowerCase()}%` });
    }
  }

  private async loadJobOrFail(id: number): Promise<Job> {
    const job = await this.jobsRepository.findOne({
      where: { id },
      relations: ['customer', 'service'],
    });
    if (!job) throw new NotFoundException(`Job with id ${id} not found.`);
    return job;
  }

  private async loadJobDto(id: number): Promise<JobResponseDto> {
    const job = await this.loadJobOrFail(id);
    return plainToInstance(JobResponseDto, job, { excludeExtraneousValues: true });
  }

  private paginate(total: number, page: number, limit: number): Pagination {
    return { total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  private assertOwner(job: Job, requestUserId: number): void {
    if (job.customerId !== requestUserId) {
      throw new ForbiddenException('You do not have permission to perform this action on this job.');
    }
  }

  private assertAcceptedArtisan(job: Job, artisanId: number): void {
    if (job.acceptedArtisanId !== artisanId) {
      throw new ForbiddenException(
        'Only the accepted artisan can perform this action on this job.',
      );
    }
  }

  private assertMutable(job: Job): void {
    if (IMMUTABLE_STATUSES.has(job.status)) {
      throw new BadRequestException(`Jobs with status ${job.status} cannot be edited.`);
    }
  }

  private assertBudget(min?: number, max?: number): void {
    if (min !== undefined && max !== undefined && Number(max) < Number(min)) {
      throw new BadRequestException('budgetMax must be greater than or equal to budgetMin.');
    }
  }
}
