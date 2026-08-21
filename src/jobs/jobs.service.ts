import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { plainToInstance } from 'class-transformer';
import {
  DataSource,
  EntityManager,
  LessThanOrEqual,
  Repository,
} from 'typeorm';
import { Job } from './entities/job.entity';
import { JobApplication } from './entities/job-application.entity';
import { JobStatusHistory } from './entities/job-status-history.entity';
import { JobAttachment } from './entities/job-attachment.entity';
import { CreateJobDto } from './dto/create-job.dto';
import { UpdateJobDto } from './dto/update-job.dto';
import { GetJobsQueryDto } from './dto/get-jobs-query.dto';
import {
  JobAttachmentDto,
  JobResponseDto,
  JobStatusHistoryDto,
} from './dto/job-response.dto';
import { CreateApplicationDto } from './dto/create-application.dto';
import { ApplicationResponseDto } from './dto/application-response.dto';
import { ServiceEntity } from '@services/entities/service.entity';
import { User } from '@users/entities/user.entity';
import { ApplicationStatus, Role, Status } from '@common/types/enums';
import { VARIABLES } from '@common/constants/variables.constants';
import { SUCCESS_MESSAGES } from '@common/constants/success-messages.constants';
import { PaymentsService } from '../payments/payments.service';
import {
  APP_EVENTS,
  JobApplicationAcceptedPayload,
  JobApplicationReceivedPayload,
  JobApplicationRejectedPayload,
  JobCancelledPayload,
  JobCompletedPayload,
  JobCompletionRequestedPayload,
  JobExpiredPayload,
  JobStartedPayload,
} from '@common/events/app.events';

const IMMUTABLE_STATUSES = new Set([
  Status.COMPLETED,
  Status.CANCELLED,
  Status.EXPIRED,
]);

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

type Pagination = {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};
type JobList = {
  message: string;
  data: JobResponseDto[];
  pagination: Pagination;
};
type JobItem = { message: string; data: JobResponseDto };
type AppItem = { message: string; data: ApplicationResponseDto };
type AppList = { message: string; data: ApplicationResponseDto[] };

@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);

  constructor(
    @InjectRepository(Job)
    private readonly jobsRepository: Repository<Job>,
    @InjectRepository(JobApplication)
    private readonly applicationsRepository: Repository<JobApplication>,
    @InjectRepository(JobStatusHistory)
    private readonly historyRepository: Repository<JobStatusHistory>,
    @InjectRepository(JobAttachment)
    private readonly attachmentsRepository: Repository<JobAttachment>,
    @InjectRepository(ServiceEntity)
    private readonly servicesRepository: Repository<ServiceEntity>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly paymentsService: PaymentsService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ─── Job CRUD ────────────────────────────────────────────────────────────────

  /**
   * Creates a new job posting. Only users with the CUSTOMER role may post jobs.
   * J4: optional `attachmentUrls` (pre-uploaded via the existing storage
   * abstraction) are persisted as `job_attachments` rows.
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

    const customer = await this.usersRepository.findOne({
      where: { id: requestUser.id },
    });
    if (!customer)
      throw new NotFoundException('Authenticated customer not found.');

    const service = await this.servicesRepository.findOne({
      where: { id: createJobDto.serviceId },
    });
    if (!service)
      throw new NotFoundException(
        `Service with id ${createJobDto.serviceId} not found.`,
      );

    const { serviceId: _serviceId, attachmentUrls, ...payload } = createJobDto;

    const saved = await this.dataSource.transaction(async (manager) => {
      const jobRow = await manager
        .getRepository(Job)
        .save(
          manager.getRepository(Job).create({ ...payload, customer, service }),
        );

      await this.recordHistory(
        manager,
        jobRow.id,
        null,
        Status.OPEN,
        String(customer.id),
      );

      for (const url of attachmentUrls ?? []) {
        await manager.getRepository(JobAttachment).save(
          manager.getRepository(JobAttachment).create({
            jobId: jobRow.id,
            url,
            fileType: this.guessMimeFromUrl(url),
          }),
        );
      }

      return jobRow;
    });

    this.logger.log(`Job ${saved.id} created by customer ${customer.id}`);
    return {
      message: SUCCESS_MESSAGES.JOB.CREATED,
      data: await this.loadJobDto(saved.id, true),
    };
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
  async update(
    id: number,
    updateJobDto: UpdateJobDto,
    requestUserId: number,
  ): Promise<JobItem> {
    const job = await this.loadJobOrFail(id);
    this.assertOwner(job, requestUserId);
    this.assertMutable(job);

    const nextMin = updateJobDto.budgetMin ?? job.budgetMin;
    const nextMax = updateJobDto.budgetMax ?? job.budgetMax;
    this.assertBudget(nextMin, nextMax);

    Object.assign(job, updateJobDto);
    await this.jobsRepository.save(job);

    this.logger.log(`Job ${id} updated by customer ${requestUserId}`);
    return {
      message: SUCCESS_MESSAGES.JOB.UPDATED,
      data: await this.loadJobDto(id),
    };
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
  async remove(
    id: number,
    requestUserId: number,
  ): Promise<{ message: string }> {
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
    const jobs = await qb
      .skip((page - 1) * limit)
      .take(limit)
      .getMany();

    return {
      message: SUCCESS_MESSAGES.JOB.ALL_RETRIEVED,
      data: plainToInstance(JobResponseDto, jobs, {
        excludeExtraneousValues: true,
      }),
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
    const jobs = await qb
      .skip((page - 1) * limit)
      .take(limit)
      .getMany();

    return {
      message: SUCCESS_MESSAGES.JOB.ALL_RETRIEVED,
      data: plainToInstance(JobResponseDto, jobs, {
        excludeExtraneousValues: true,
      }),
      pagination: this.paginate(total, page, limit),
    };
  }

  /**
   * Returns a single job by its ID with customer and service relations.
   * J3: also includes the real chronological `statusHistory` array (broad-read —
   * same authorization as the rest of this endpoint, deliberately unchanged by J3/J4).
   * J4: also includes `attachments`.
   *
   * @param id - The job ID.
   * @throws {NotFoundException} When no non-deleted job with the given ID exists.
   */
  async findOne(id: number): Promise<JobItem> {
    return {
      message: SUCCESS_MESSAGES.JOB.RETRIEVED,
      data: await this.loadJobDto(id, true),
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

    const artisan = await this.usersRepository.findOne({
      where: { id: artisanId },
    });
    if (!artisan)
      throw new NotFoundException('Authenticated artisan not found.');

    const application = await this.applicationsRepository.save(
      this.applicationsRepository.create({ job, artisan, ...dto }),
    );

    this.logger.log(
      `Artisan ${artisanId} applied to job ${jobId} (application ${application.id})`,
    );

    this.eventEmitter.emit(APP_EVENTS.JOB_APPLICATION_RECEIVED, {
      customerId: job.customer.id,
      artisanName: `${artisan.firstname} ${artisan.lastname}`,
      jobTitle: job.title ?? `Job #${job.id}`,
      jobId: job.id,
    } as JobApplicationReceivedPayload);

    const populated = await this.applicationsRepository.findOne({
      where: { id: application.id },
      relations: ['artisan'],
    });

    return {
      message: SUCCESS_MESSAGES.JOB.APPLICATION_SUBMITTED,
      data: plainToInstance(ApplicationResponseDto, populated, {
        excludeExtraneousValues: true,
      }),
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
      data: plainToInstance(ApplicationResponseDto, applications, {
        excludeExtraneousValues: true,
      }),
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
  async acceptApplication(
    jobId: number,
    appId: number,
    customerId: number,
  ): Promise<JobItem> {
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
      throw new NotFoundException(
        `Application ${appId} not found for job ${jobId}.`,
      );
    }
    if (application.status !== ApplicationStatus.PENDING) {
      throw new BadRequestException(
        `Only PENDING applications can be accepted. This application is ${application.status}.`,
      );
    }

    // Load other pending applicants before bulk-rejecting so we can notify them.
    const pendingApplications = await this.applicationsRepository.find({
      where: { job: { id: jobId }, status: ApplicationStatus.PENDING },
      relations: ['artisan'],
    });

    // Hold payment before committing any DB changes so a payment failure
    // leaves the job OPEN. qa-report.md BLOCKER-1: the accepted artisan's id
    // is passed explicitly (from the already-loaded application) rather than
    // relying on holdPayment to re-derive it from `job.acceptedArtisanId` —
    // that relation isn't saved to the job row until *after* this call, so a
    // re-query would always see the pre-acceptance state and always fail.
    const intentId = await this.paymentsService.holdPayment(
      jobId,
      customerId,
      application.artisan.id,
      application.quotePrice,
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
    const fromStatus = job.status;
    job.status = Status.PENDING;
    job.acceptedArtisan = application.artisan;
    job.paymentIntentId = intentId;
    await this.jobsRepository.save(job);
    await this.recordHistory(
      this.dataSource.manager,
      job.id,
      fromStatus,
      Status.PENDING,
      String(customerId),
      `Application ${appId} accepted`,
    );

    this.logger.log(
      `Job ${jobId} → PENDING. Accepted artisan ${application.artisanId}. Intent: ${intentId}`,
    );

    this.eventEmitter.emit(APP_EVENTS.JOB_APPLICATION_ACCEPTED, {
      artisanId: application.artisan.id,
      jobTitle: job.title ?? `Job #${job.id}`,
      jobId: job.id,
    } as JobApplicationAcceptedPayload);

    // Notify each rejected applicant.
    for (const rejected of pendingApplications.filter((a) => a.id !== appId)) {
      this.eventEmitter.emit(APP_EVENTS.JOB_APPLICATION_REJECTED, {
        artisanId: rejected.artisan.id,
        jobTitle: job.title ?? `Job #${job.id}`,
        jobId: job.id,
      } as JobApplicationRejectedPayload);
    }

    return {
      message: SUCCESS_MESSAGES.JOB.APPLICATION_ACCEPTED,
      data: await this.loadJobDto(jobId),
    };
  }

  // ─── State transitions ───────────────────────────────────────────────────────

  /**
   * Advances a PENDING job to IN_PROGRESS. Only the accepted artisan may call this.
   * J1: works identically regardless of whether the job arrived via the
   * open-posting apply/accept flow or the R2 booking-linkage flow.
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

    await this.transitionAndSave(job, Status.IN_PROGRESS, String(artisanId));

    this.logger.log(`Job ${jobId} → IN_PROGRESS by artisan ${artisanId}`);

    this.eventEmitter.emit(APP_EVENTS.JOB_STARTED, {
      customerId: job.customer.id,
      jobTitle: job.title ?? `Job #${job.id}`,
      jobId: job.id,
    } as JobStartedPayload);

    return {
      message: SUCCESS_MESSAGES.JOB.STARTED,
      data: await this.loadJobDto(jobId),
    };
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
      throw new BadRequestException(
        'Completion has already been requested for this job.',
      );
    }

    job.completionRequestedAt = new Date();
    await this.jobsRepository.save(job);

    this.logger.log(
      `Job ${jobId} — completion requested by artisan ${artisanId}`,
    );

    this.eventEmitter.emit(APP_EVENTS.JOB_COMPLETION_REQUESTED, {
      customerId: job.customer.id,
      jobTitle: job.title ?? `Job #${job.id}`,
      jobId: job.id,
    } as JobCompletionRequestedPayload);

    return {
      message: SUCCESS_MESSAGES.JOB.COMPLETION_REQUESTED,
      data: await this.loadJobDto(jobId),
    };
  }

  /**
   * Customer confirms the work is done. Advances job to COMPLETED and captures the payment.
   * Can only be called after the artisan has called {@link requestCompletion}.
   *
   * Row-locked (`SELECT ... FOR UPDATE`) so this can never race with J2's
   * cron-driven {@link autoCompleteJob} for the same job — whichever wins,
   * the job ends up COMPLETED exactly once with exactly one payment capture.
   *
   * security-report.md finding #1: payment capture (and the real Paystack
   * transfer call inside it) deliberately happens *after* this transaction
   * commits, not inside it. `PaymentsService.capturePayment` reads/writes
   * the Payment row through its own connection/lock (see finding #3's fix)
   * and cannot be rolled back by this method's transaction regardless of
   * where it's called from — so nesting it here bought no atomicity, it only
   * meant an unrelated failure *after* a successful transfer (a transient
   * `recordHistory` error, a dropped connection) would roll the Job back to
   * IN_PROGRESS while the transfer had already gone out, and a subsequent
   * retry would then capture (and transfer) a second time. Marking the job
   * COMPLETED is now the atomic, transactional step; payment capture is a
   * separate, idempotent, independently-retryable step (via
   * `POST /payments/retry-transfer/:jobId`) that can never un-complete the
   * job if it fails.
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
    let paymentIntentId: string | undefined;

    await this.dataSource.transaction(async (manager) => {
      const jobRepo = manager.getRepository(Job);
      // No `relations` here deliberately: Postgres rejects `FOR UPDATE`
      // combined with a LEFT JOIN on the nullable side (0A000) — and
      // neither `customer` nor `service` is read below (assertOwner only
      // needs job.customerId, a real column, not the loaded relation).
      const job = await jobRepo.findOne({
        where: { id: jobId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!job) throw new NotFoundException(`Job with id ${jobId} not found.`);
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

      paymentIntentId = job.paymentIntentId;

      job.status = Status.COMPLETED;
      await jobRepo.save(job);
      await this.recordHistory(
        manager,
        job.id,
        Status.IN_PROGRESS,
        Status.COMPLETED,
        String(customerId),
      );
    });

    // Outside the transaction: the job's COMPLETED status has already
    // durably committed. A capture failure here must never roll that back —
    // it leaves the Payment in a retryable state (PENDING_TRANSFER /
    // TRANSFER_FAILED) instead, surfaced to the artisan/admin.
    if (paymentIntentId) {
      try {
        await this.paymentsService.capturePayment(paymentIntentId, jobId);
      } catch (err) {
        this.logger.error(
          `Job ${jobId} confirmed COMPLETED but payment capture failed — payment left in a retryable state. ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const job = await this.loadJobOrFail(jobId);
    this.logger.log(
      `Job ${jobId} → COMPLETED. Payment captured. Customer ${customerId}`,
    );

    if (job.acceptedArtisanId) {
      this.eventEmitter.emit(APP_EVENTS.JOB_COMPLETED, {
        artisanId: job.acceptedArtisanId,
        jobTitle: job.title ?? `Job #${job.id}`,
        jobId: job.id,
      } as JobCompletedPayload);
    }

    return {
      message: SUCCESS_MESSAGES.JOB.CONFIRMED,
      data: await this.loadJobDto(jobId),
    };
  }

  /**
   * Cancels a job. Available to the customer as long as the job is not already
   * COMPLETED or CANCELLED. If a payment hold exists (PENDING or IN_PROGRESS),
   * the hold is cancelled (full refund).
   *
   * security-report.md finding #2: previously did an unlocked read followed
   * by a separate, also-unlocked save — nothing stopped this from racing a
   * concurrent {@link confirmCompletion}/{@link autoCompleteJob} for the same
   * job (both of which *do* take a row lock, but only against each other,
   * never against this method). Now takes the same `pessimistic_write` lock
   * on the Job row, so a cancellation and a completion-confirmation can never
   * both proceed for the same job. As additional defense-in-depth,
   * cancellation is refused outright once the artisan has requested
   * completion — at that point a payout may already be mid-flight, and
   * self-service cancellation is no longer safe; a dispute/admin path should
   * be used instead. (`PaymentsService.cancelPayment`/`capturePayment` also
   * independently lock the Payment row itself — see finding #2/#3's fix
   * there — so even a residual timing edge here can't result in both a
   * refund and a transfer for the same payment.)
   *
   * @param jobId      - The job ID.
   * @param customerId - Authenticated customer's user ID.
   * @returns Confirmation message.
   * @throws {NotFoundException}   When the job does not exist.
   * @throws {ForbiddenException}  When the caller does not own the job.
   * @throws {BadRequestException} When the job cannot be cancelled.
   */
  async cancelJob(
    jobId: number,
    customerId: number,
  ): Promise<{ message: string }> {
    let paymentIntentId: string | undefined;
    let acceptedArtisanId: number | undefined;
    let jobTitle: string | undefined;

    await this.dataSource.transaction(async (manager) => {
      const jobRepo = manager.getRepository(Job);
      // No `relations` here deliberately, matching confirmCompletion/
      // autoCompleteJob: Postgres rejects `FOR UPDATE` combined with a LEFT
      // JOIN on the nullable side (0A000), and nothing below needs a loaded
      // relation (assertOwner uses the real `customerId` column; the
      // artisan id/title used for the emitted event are read off the same
      // row's plain columns).
      const job = await jobRepo.findOne({
        where: { id: jobId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!job) throw new NotFoundException(`Job with id ${jobId} not found.`);
      this.assertOwner(job, customerId);

      if (job.status === Status.COMPLETED || job.status === Status.CANCELLED) {
        throw new BadRequestException(
          `A ${job.status} job cannot be cancelled.`,
        );
      }
      if (job.status === Status.EXPIRED) {
        throw new BadRequestException('An expired job cannot be cancelled.');
      }
      if (job.completionRequestedAt) {
        throw new BadRequestException(
          'This job cannot be self-cancelled once the artisan has requested completion. Raise a dispute instead.',
        );
      }

      paymentIntentId = job.paymentIntentId;
      acceptedArtisanId = job.acceptedArtisanId;
      jobTitle = job.title;

      const fromStatus = job.status;
      job.paymentIntentId = undefined;
      job.status = Status.CANCELLED;
      await jobRepo.save(job);
      await this.recordHistory(
        manager,
        job.id,
        fromStatus,
        Status.CANCELLED,
        String(customerId),
      );
    });

    // Release the payment hold if one exists. Runs after the job's
    // CANCELLED status has committed, and locks the Payment row itself
    // (see PaymentsService.cancelPayment), so it safely no-ops if a
    // concurrent capture already moved the payment past a
    // refundable/cancellable state.
    if (paymentIntentId) {
      await this.paymentsService.cancelPayment(paymentIntentId, jobId);
    }

    this.logger.log(`Job ${jobId} → CANCELLED by customer ${customerId}`);

    if (acceptedArtisanId) {
      this.eventEmitter.emit(APP_EVENTS.JOB_CANCELLED, {
        artisanId: acceptedArtisanId,
        jobTitle: jobTitle ?? `Job #${jobId}`,
        jobId,
      } as JobCancelledPayload);
    }

    return { message: SUCCESS_MESSAGES.JOB.CANCELLED };
  }

  // ─── Admin / scheduler actions ──────────────────────────────────────────────

  /**
   * Marks an OPEN job as EXPIRED, rejects all pending applications, and
   * emits notifications so the customer and waiting artisans are informed.
   * Called by the scheduled jobs module (Phase 9) or admin (Phase 6).
   * Silently no-ops if the job is not OPEN.
   *
   * @param jobId - The job to expire.
   */
  async expireJob(jobId: number): Promise<void> {
    const job = await this.loadJobOrFail(jobId);
    if (job.status !== Status.OPEN) return;

    // Load pending applicants before marking them rejected so we can notify them.
    const pendingApplications = await this.applicationsRepository.find({
      where: { job: { id: jobId }, status: ApplicationStatus.PENDING },
      relations: ['artisan'],
    });

    if (pendingApplications.length > 0) {
      await this.applicationsRepository
        .createQueryBuilder()
        .update(JobApplication)
        .set({ status: ApplicationStatus.REJECTED })
        .where('job_id = :jobId AND status = :status', {
          jobId,
          status: ApplicationStatus.PENDING,
        })
        .execute();
    }

    await this.transitionAndSave(job, Status.EXPIRED, 'SYSTEM');

    this.logger.log(
      `Job ${jobId} → EXPIRED. ${pendingApplications.length} pending applications closed.`,
    );

    this.eventEmitter.emit(APP_EVENTS.JOB_EXPIRED, {
      customerId: job.customer.id,
      jobTitle: job.title ?? `Job #${job.id}`,
      jobId: job.id,
      pendingArtisanIds: pendingApplications.map((a) => a.artisan.id),
    } as JobExpiredPayload);
  }

  // ─── J2: 48h auto-complete cron entry points ─────────────────────────────────

  /**
   * Candidate IDs for J2: IN_PROGRESS jobs where completion was requested at
   * least 48h ago and the customer never confirmed. "At least" (not
   * "exactly") so a delayed/paused cron still catches everything overdue on
   * its next run.
   */
  async findAutoCompleteCandidateIds(): Promise<number[]> {
    const cutoff = new Date(
      Date.now() - VARIABLES.JOB_AUTO_COMPLETE_HOURS * 60 * 60 * 1000,
    );
    const rows = await this.jobsRepository.find({
      where: {
        status: Status.IN_PROGRESS,
        completionRequestedAt: LessThanOrEqual(cutoff),
      },
      select: ['id'],
    });
    return rows.map((r) => r.id);
  }

  /**
   * J2: system-driven equivalent of {@link confirmCompletion}. Row-locked so
   * it can never race a concurrent manual customer confirmation — whichever
   * transaction wins, the job is COMPLETED exactly once with exactly one
   * payment capture.
   *
   * security-report.md finding #1: as with {@link confirmCompletion},
   * payment capture happens *after* this transaction commits, not inside
   * it — nesting it here bought no atomicity (the Payment row/Paystack call
   * are outside this transaction's connection regardless), it only meant an
   * unrelated failure after a successful transfer would roll the job back to
   * IN_PROGRESS while money had already moved, setting up a double-transfer
   * on the next cron run. A capture failure is now logged and left for the
   * artisan/admin retry path rather than un-completing the job.
   *
   * @returns `true` if this call actually completed the job, `false` if it
   *          was already handled (by a prior run or a manual confirmation) —
   *          the idempotency contract the cron relies on.
   */
  async autoCompleteJob(jobId: number): Promise<boolean> {
    let paymentIntentId: string | undefined;

    const completed = await this.dataSource.transaction(async (manager) => {
      const jobRepo = manager.getRepository(Job);
      // No `relations` here deliberately: Postgres rejects `FOR UPDATE`
      // combined with a LEFT JOIN on the nullable side (0A000), which is
      // what TypeORM generates when `relations` and `lock` are combined in
      // one query — and neither `customer` nor `service` is actually read
      // below, so there's nothing to join in the first place.
      const job = await jobRepo.findOne({
        where: { id: jobId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!job) return false;
      if (job.status !== Status.IN_PROGRESS || !job.completionRequestedAt) {
        return false;
      }
      const elapsedMs =
        Date.now() - new Date(job.completionRequestedAt).getTime();
      if (elapsedMs < VARIABLES.JOB_AUTO_COMPLETE_HOURS * 60 * 60 * 1000) {
        return false;
      }

      paymentIntentId = job.paymentIntentId;

      job.status = Status.COMPLETED;
      await jobRepo.save(job);
      await this.recordHistory(
        manager,
        job.id,
        Status.IN_PROGRESS,
        Status.COMPLETED,
        'SYSTEM',
        'auto-completed after 48h — customer did not respond',
      );
      return true;
    });

    if (!completed) return false;

    // Outside the transaction, matching confirmCompletion — the job's
    // COMPLETED status has already durably committed, so a capture failure
    // here is logged and left retryable rather than un-completing the job.
    if (paymentIntentId) {
      try {
        await this.paymentsService.capturePayment(paymentIntentId, jobId);
      } catch (err) {
        this.logger.error(
          `Job ${jobId} auto-completed but payment capture failed — payment left in a retryable state. ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const job = await this.loadJobOrFail(jobId);
    this.logger.log(`Job ${jobId} → COMPLETED (auto-complete, J2)`);
    if (job.acceptedArtisanId) {
      this.eventEmitter.emit(APP_EVENTS.JOB_COMPLETED, {
        artisanId: job.acceptedArtisanId,
        jobTitle: job.title ?? `Job #${job.id}`,
        jobId: job.id,
      } as JobCompletedPayload);
    }
    return true;
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  private buildJobsQb() {
    return this.jobsRepository
      .createQueryBuilder('job')
      .leftJoinAndSelect('job.customer', 'customer')
      .leftJoinAndSelect('job.service', 'service')
      .orderBy('job.createdAt', 'DESC');
  }

  private applyJobFilters(
    qb: ReturnType<typeof this.buildJobsQb>,
    query: GetJobsQueryDto,
  ) {
    if (query.status)
      qb.andWhere('job.status = :status', { status: query.status });
    if (query.serviceId)
      qb.andWhere('job.service = :serviceId', { serviceId: query.serviceId });
    if (query.location) {
      qb.andWhere('LOWER(job.location) LIKE :loc', {
        loc: `%${query.location.toLowerCase()}%`,
      });
    }
  }

  private async loadJobOrFail(id: number): Promise<Job> {
    // qa-report.md MEDIUM: `acceptedArtisan` is now loaded here so
    // GET /jobs/:id (and every other caller of loadJobDto/loadJobOrFail) can
    // actually expose who the job was accepted to, instead of the frontend's
    // "Assigned Artisan" card always reading empty on completed/paid jobs.
    const job = await this.jobsRepository.findOne({
      where: { id },
      relations: ['customer', 'service', 'acceptedArtisan'],
    });
    if (!job) throw new NotFoundException(`Job with id ${id} not found.`);
    return job;
  }

  /**
   * @param withDetail - J3/J4: when true, also loads `statusHistory`
   *   (chronological) and `attachments` — used for the single-job detail
   *   response, omitted on list endpoints to keep them within the <500ms
   *   p95 target (NFR (d)).
   */
  private async loadJobDto(
    id: number,
    withDetail = false,
  ): Promise<JobResponseDto> {
    const job = await this.loadJobOrFail(id);
    const dto = plainToInstance(JobResponseDto, job, {
      excludeExtraneousValues: true,
    });
    if (withDetail) {
      const [history, attachments] = await Promise.all([
        this.historyRepository.find({
          where: { jobId: id },
          order: { createdAt: 'ASC', id: 'ASC' },
        }),
        this.attachmentsRepository.find({ where: { jobId: id } }),
      ]);
      dto.statusHistory = plainToInstance(JobStatusHistoryDto, history, {
        excludeExtraneousValues: true,
      });
      dto.attachments = plainToInstance(JobAttachmentDto, attachments, {
        excludeExtraneousValues: true,
      });
    }
    return dto;
  }

  private paginate(total: number, page: number, limit: number): Pagination {
    return { total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  private assertOwner(job: Job, requestUserId: number): void {
    if (job.customerId !== requestUserId) {
      throw new ForbiddenException(
        'You do not have permission to perform this action on this job.',
      );
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
      throw new BadRequestException(
        `Jobs with status ${job.status} cannot be edited.`,
      );
    }
  }

  private assertBudget(min?: number, max?: number): void {
    if (min !== undefined && max !== undefined && Number(max) < Number(min)) {
      throw new BadRequestException(
        'budgetMax must be greater than or equal to budgetMin.',
      );
    }
  }

  /**
   * J3: sets `job.status` and appends a `job_status_history` row atomically
   * inside a single transaction, so the two are never observed out of sync
   * with each other.
   */
  private async transitionAndSave(
    job: Job,
    toStatus: Status,
    changedBy: string,
    reason?: string,
  ): Promise<void> {
    const fromStatus = job.status;
    await this.dataSource.transaction(async (manager) => {
      job.status = toStatus;
      await manager.getRepository(Job).save(job);
      await this.recordHistory(
        manager,
        job.id,
        fromStatus,
        toStatus,
        changedBy,
        reason,
      );
    });
  }

  private async recordHistory(
    manager: EntityManager,
    jobId: number,
    fromStatus: Status | null,
    toStatus: Status,
    changedBy: string,
    reason?: string,
  ): Promise<void> {
    const repo = manager.getRepository(JobStatusHistory);
    await repo.save(
      repo.create({ jobId, fromStatus, toStatus, changedBy, reason }),
    );
  }

  private guessMimeFromUrl(url: string): string {
    const ext = url.slice(url.lastIndexOf('.')).toLowerCase();
    return MIME_BY_EXT[ext] ?? 'image/jpeg';
  }
}
