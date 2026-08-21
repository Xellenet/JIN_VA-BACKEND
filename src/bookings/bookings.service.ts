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
import { DataSource, LessThan, Repository } from 'typeorm';
import { Booking } from './entities/booking.entity';
import { CreateBookingDto } from './dto/create-booking.dto';
import { RespondBookingDto } from './dto/respond-booking.dto';
import { GetBookingsQueryDto } from './dto/get-bookings-query.dto';
import { BookingResponseDto } from './dto/booking-response.dto';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { User } from '@users/entities/user.entity';
import { ServiceEntity } from '@services/entities/service.entity';
import { ArtisanAvailability } from '../availability/entities/artisan-availability.entity';
import { AvailabilityService } from '../availability/availability.service';
import { Job } from '@jobs/entities/job.entity';
import { JobStatusHistory } from '@jobs/entities/job-status-history.entity';
import { JobAttachment } from '@jobs/entities/job-attachment.entity';
import { BookingStatus, NoShowParty, Role, Status } from '@common/types/enums';
import { VARIABLES } from '@common/constants/variables.constants';
import { APP_EVENTS } from '@common/events/app.events';
import type {
  BookingCancelledPayload,
  BookingCompletedPayload,
  BookingConfirmedPayload,
  BookingDeclinedPayload,
  BookingExpiredPayload,
  BookingNoShowPayload,
  BookingReceivedPayload,
  BookingReminderPayload,
} from '@common/events/app.events';

type Pagination = {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

/** Bookings in these statuses occupy a slot for concurrency purposes (A4/A9/R1a). */
const OCCUPYING_BOOKING_STATUSES = [
  BookingStatus.PENDING,
  BookingStatus.CONFIRMED,
];

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

@Injectable()
export class BookingsService {
  private readonly logger = new Logger(BookingsService.name);

  constructor(
    @InjectRepository(Booking)
    private readonly repo: Repository<Booking>,
    @InjectRepository(ArtisanProfile)
    private readonly profileRepo: Repository<ArtisanProfile>,
    @InjectRepository(ArtisanAvailability)
    private readonly slotRepo: Repository<ArtisanAvailability>,
    @InjectRepository(ServiceEntity)
    private readonly serviceRepo: Repository<ServiceEntity>,
    @InjectRepository(Job)
    private readonly jobRepo: Repository<Job>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly availabilityService: AvailabilityService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ─── R1/A4/A9: atomic, concurrency-safe create ───────────────────────────────

  /**
   * A4: the create path is wrapped in a single DB transaction that takes a
   * `SELECT ... FOR UPDATE` lock on the *artisan profile* row before checking
   * for an overlapping booking and inserting. Locking the (always-existing)
   * parent profile row — rather than the candidate booking rows, which may
   * not exist yet (the classic phantom-row problem) — is what makes this a
   * real serialization point per artisan: two concurrent requests for the
   * same artisan queue behind the same row lock, so the overlap check and
   * the insert can never both "pass" for two different requests. Different
   * artisans use different profile rows, so unrelated bookings are never
   * serialized against each other (NFR (a), (d), (e)).
   *
   * A9 (the per-customer-per-artisan PENDING cap) is enforced inside the
   * exact same lock scope, for the same reason: two near-simultaneous
   * requests from the same customer must not both pass the count check.
   */
  async create(customerId: number, dto: CreateBookingDto) {
    const profile = await this.profileRepo.findOne({
      where: { id: dto.artisanProfileId },
      relations: ['user'],
    });
    if (!profile) throw new NotFoundException('Artisan profile not found.');

    const service = await this.serviceRepo.findOne({
      where: { id: dto.serviceId },
    });
    if (!service)
      throw new NotFoundException(
        `Service with id ${dto.serviceId} not found.`,
      );

    let slot: ArtisanAvailability | undefined;
    if (dto.availabilitySlotId) {
      const found = await this.slotRepo.findOne({
        where: {
          id: dto.availabilitySlotId,
          artisanProfileId: dto.artisanProfileId,
          isActive: true,
        },
      });
      if (!found)
        throw new NotFoundException('Availability slot not found or inactive.');
      slot = found;
    }

    // Security report finding (Low, CWE-840/price integrity): agreedPrice was
    // fully customer-controlled with no tie to the service's catalog price.
    // Currently no payment capture is wired to this value (see
    // `confirm()`/`PaymentsService.holdPayment` — not called for
    // booking-derived jobs), but this closes the gap before that follow-up
    // integration lands, rather than after. `service.price` is optional
    // (legacy/unpriced catalog rows), so the check only applies when it's set.
    if (
      dto.agreedPrice != null &&
      service.price != null &&
      Number(service.price) > 0
    ) {
      const catalogPrice = Number(service.price);
      const tolerance = VARIABLES.AGREED_PRICE_TOLERANCE_RATIO;
      const min = catalogPrice * (1 - tolerance);
      const max = catalogPrice * (1 + tolerance);
      if (dto.agreedPrice < min || dto.agreedPrice > max) {
        throw new BadRequestException(
          `agreedPrice must be within ${tolerance * 100}% of this service's listed price ` +
            `(GHS ${catalogPrice.toFixed(2)}).`,
        );
      }
    }

    const durationMins =
      service.estimatedDurationMins || VARIABLES.DEFAULT_SERVICE_DURATION_MINS;
    const endTime = dto.endTime ?? this.addMinutes(dto.startTime, durationMins);

    if (endTime <= dto.startTime) {
      throw new BadRequestException('endTime must be after startTime.');
    }

    // NFR (c): the scheduling decision ("is this in the past?") is computed
    // purely from the server's UTC clock against the UTC instant the
    // scheduledDate/startTime strings represent — never a client-supplied
    // "now".
    const startInstant = this.toUtcInstant(dto.scheduledDate, dto.startTime);
    if (Number.isNaN(startInstant.getTime())) {
      throw new BadRequestException('Invalid scheduledDate/startTime.');
    }
    if (startInstant.getTime() <= Date.now()) {
      throw new BadRequestException(
        'Cannot request a booking for a date/time that has already passed.',
      );
    }

    // R1a-consistency check: reject up front (before taking any lock) if the
    // request falls outside working hours, inside a blocked range, or is
    // already occupied — using the exact same computation the read path
    // (GET /availability/:id?date=) uses, so the picker and this check never
    // disagree. This is a fast-fail; the authoritative, race-safe guard is
    // the transactional overlap check below.
    const bookable = await this.availabilityService.computeBookableWindows(
      dto.artisanProfileId,
      dto.scheduledDate,
    );
    const fits = bookable.some(
      (w) => dto.startTime >= w.startTime && endTime <= w.endTime,
    );
    if (!fits) {
      throw new BadRequestException(
        'The requested time is outside this artisan’s available hours, blocked, or already booked.',
      );
    }

    const result = await this.dataSource.transaction(async (manager) => {
      const profileRepo = manager.getRepository(ArtisanProfile);
      const bookingRepo = manager.getRepository(Booking);

      // Serialization point: locks only this artisan's profile row.
      // Postgres rejects `SELECT ... FOR UPDATE` combined with a LEFT JOIN
      // on the nullable side (0A000 "FOR UPDATE cannot be applied to the
      // nullable side of an outer join") — which is exactly what TypeORM
      // generates when `relations` is combined with `lock` in one query.
      // Acquire the lock first with no relations, then load `user`
      // separately (safe: it's an unlocked read of a row this same
      // transaction already holds the write lock on).
      const lockedProfile = await profileRepo.findOne({
        where: { id: dto.artisanProfileId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!lockedProfile)
        throw new NotFoundException('Artisan profile not found.');
      const profileWithUser = await profileRepo.findOne({
        where: { id: lockedProfile.id },
        relations: ['user'],
      });
      lockedProfile.user = profileWithUser!.user;
      if (lockedProfile.user.isBanned) {
        // Re-checked here (not just at page-load time) per R1's edge case:
        // an artisan suspended between page load and submit must not be
        // bookable.
        throw new BadRequestException(
          'This artisan is not currently accepting bookings.',
        );
      }

      // A4: overlap check, excluding terminal-negative statuses (CANCELLED,
      // DECLINED, EXPIRED, NO_SHOW) — a customer who cancels frees the slot
      // immediately, no ghost lock.
      const overlap = await bookingRepo
        .createQueryBuilder('b')
        .where('b.artisan_profile_id = :artisanProfileId', {
          artisanProfileId: dto.artisanProfileId,
        })
        .andWhere('b.scheduled_date = :scheduledDate', {
          scheduledDate: dto.scheduledDate,
        })
        .andWhere('b.status IN (:...statuses)', {
          statuses: OCCUPYING_BOOKING_STATUSES,
        })
        .andWhere('b.start_time < :endTime', { endTime })
        .andWhere('b.end_time > :startTime', { startTime: dto.startTime })
        .getOne();
      if (overlap) {
        throw new ConflictException(
          'This time is no longer available. Please pick another slot.',
        );
      }

      // A9: cap simultaneous PENDING bookings per-customer-per-artisan,
      // checked inside the same lock scope as the overlap check above so
      // the two checks can't both pass concurrently for the same customer.
      const pendingCount = await bookingRepo.count({
        where: {
          // customerId/artisanProfileId are @RelationId (virtual, not real
          // columns) — same fix as the read path in
          // AvailabilityService.computeBookableWindows: filter via the
          // relation objects instead.
          customer: { id: customerId },
          artisanProfile: { id: dto.artisanProfileId },
          status: BookingStatus.PENDING,
        },
      });
      if (pendingCount >= VARIABLES.MAX_PENDING_BOOKINGS_PER_ARTISAN) {
        throw new ConflictException(
          `You already have ${VARIABLES.MAX_PENDING_BOOKINGS_PER_ARTISAN} pending requests with this artisan. ` +
            'Wait for a response or let one expire before requesting another.',
        );
      }

      const booking = bookingRepo.create({
        customer: { id: customerId } as User,
        artisanProfile: lockedProfile,
        artisanProfileId: lockedProfile.id,
        service: { id: service.id } as ServiceEntity,
        serviceId: service.id,
        availabilitySlot: slot,
        availabilitySlotId: slot?.id,
        scheduledDate: dto.scheduledDate,
        startTime: dto.startTime,
        endTime,
        notes: dto.notes,
        agreedPrice: dto.agreedPrice,
        currency: dto.currency ?? 'GHS',
        attachmentUrls: dto.attachmentUrls,
      });

      const saved = await bookingRepo.save(booking);
      return { saved, artisanUser: lockedProfile.user };
    });

    const loaded = await this.loadOrFail(result.saved.id);

    this.eventEmitter.emit(APP_EVENTS.BOOKING_RECEIVED, {
      artisanUserId: result.artisanUser.id,
      customerName: `${loaded.customer.firstname} ${loaded.customer.lastname}`,
      scheduledDate: dto.scheduledDate,
      bookingId: result.saved.id,
    } as BookingReceivedPayload);

    return {
      message: 'Booking request sent. Awaiting artisan confirmation.',
      data: await this.toResponseDto(loaded),
    };
  }

  async getMyBookings(customerId: number, query: GetBookingsQueryDto) {
    return this.list({ customerId }, query);
  }

  async getArtisanBookings(artisanUserId: number, query: GetBookingsQueryDto) {
    const profile = await this.profileRepo.findOne({
      where: { user: { id: artisanUserId } },
    });
    if (!profile) throw new NotFoundException('Artisan profile not found.');
    return this.list({ artisanProfileId: profile.id }, query);
  }

  async findOne(bookingId: number, requestUserId: number) {
    const booking = await this.loadOrFail(bookingId);
    const isCustomer = booking.customerId === requestUserId;
    const isArtisan = booking.artisanProfile?.user?.id === requestUserId;
    if (!isCustomer && !isArtisan)
      throw new ForbiddenException('Access denied.');
    return {
      message: 'Booking retrieved.',
      data: await this.toResponseDto(booking),
    };
  }

  // ─── R2: confirm creates/links a Job, wrapped in one transaction ─────────────

  async confirm(
    artisanUserId: number,
    bookingId: number,
    dto: RespondBookingDto,
  ) {
    const { booking, job } = await this.dataSource.transaction(
      async (manager) => {
        const bookingRepo = manager.getRepository(Booking);
        const jobRepo = manager.getRepository(Job);
        const historyRepo = manager.getRepository(JobStatusHistory);
        const attachmentRepo = manager.getRepository(JobAttachment);

        // Postgres rejects `FOR UPDATE` combined with a LEFT JOIN on the
        // nullable side (0A000) — which is what `relations` + `lock`
        // together generate. Acquire the lock first with no relations,
        // then load them separately (safe: same transaction already holds
        // the write lock on this row) since assertArtisanOwner and the
        // job-creation code below both genuinely need them.
        const lockedBooking = await bookingRepo.findOne({
          where: { id: bookingId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!lockedBooking) throw new NotFoundException('Booking not found.');
        const bookingRow = await bookingRepo.findOne({
          where: { id: lockedBooking.id },
          relations: [
            'artisanProfile',
            'artisanProfile.user',
            'customer',
            'service',
          ],
        });
        if (!bookingRow) throw new NotFoundException('Booking not found.');
        this.assertArtisanOwner(bookingRow, artisanUserId);
        if (bookingRow.status !== BookingStatus.PENDING) {
          // Duplicate-confirmation race guard: a second call sees the
          // already-CONFIRMED (or otherwise non-PENDING) row and rejects —
          // it never reaches job creation.
          throw new BadRequestException(
            `Cannot confirm a booking with status ${bookingRow.status}.`,
          );
        }

        bookingRow.status = BookingStatus.CONFIRMED;
        bookingRow.artisanNotes = dto.artisanNotes;
        await bookingRepo.save(bookingRow);

        // Belt-and-suspenders duplicate-job guard: the pessimistic lock plus
        // the PENDING-only check above already prevent two confirmations
        // from both reaching here, and `uq_jobs_booking_id` is the DB-level
        // backstop if they somehow did.
        let jobRow = await jobRepo.findOne({
          // Job.bookingId is a @RelationId (virtual, not a real column) —
          // filter via the relation object instead.
          where: { booking: { id: bookingRow.id } },
        });
        if (!jobRow) {
          if (!bookingRow.service) {
            throw new BadRequestException(
              'This booking has no associated service and cannot be confirmed into a job.',
            );
          }
          const location =
            bookingRow.artisanProfile.location ??
            bookingRow.artisanProfile.businessName ??
            'Not specified';

          jobRow = jobRepo.create({
            customer: bookingRow.customer,
            service: bookingRow.service,
            title: `${bookingRow.service.name} — booking #${bookingRow.id}`,
            description:
              bookingRow.notes ??
              `Direct booking with ${bookingRow.artisanProfile.businessName ?? 'artisan'}.`,
            location,
            currency: bookingRow.currency,
            budgetMin: bookingRow.agreedPrice,
            budgetMax: bookingRow.agreedPrice,
            status: Status.PENDING,
            acceptedArtisan: bookingRow.artisanProfile.user,
            booking: bookingRow,
          } as Partial<Job>);
          jobRow = await jobRepo.save(jobRow);

          await historyRepo.save(
            historyRepo.create({
              jobId: jobRow.id,
              fromStatus: null,
              toStatus: Status.PENDING,
              changedBy: String(artisanUserId),
              reason: `Created from confirmed booking #${bookingRow.id}`,
            }),
          );

          for (const url of bookingRow.attachmentUrls ?? []) {
            await attachmentRepo.save(
              attachmentRepo.create({
                jobId: jobRow.id,
                url,
                fileType: this.guessMimeFromUrl(url),
              }),
            );
          }
        }

        return { booking: bookingRow, job: jobRow };
      },
    );

    this.eventEmitter.emit(APP_EVENTS.BOOKING_CONFIRMED, {
      customerId: booking.customerId,
      artisanName:
        booking.artisanProfile.businessName ??
        `${booking.artisanProfile.user.firstname} ${booking.artisanProfile.user.lastname}`,
      scheduledDate: booking.scheduledDate,
      bookingId: booking.id,
    } as BookingConfirmedPayload);

    return { message: 'Booking confirmed.', data: { jobId: job.id } };
  }

  async decline(
    artisanUserId: number,
    bookingId: number,
    dto: RespondBookingDto,
  ) {
    const booking = await this.loadOrFail(bookingId, [
      'artisanProfile',
      'artisanProfile.user',
      'customer',
    ]);
    this.assertArtisanOwner(booking, artisanUserId);
    if (booking.status !== BookingStatus.PENDING) {
      throw new BadRequestException(
        `Cannot decline a booking with status ${booking.status}.`,
      );
    }
    booking.status = BookingStatus.DECLINED;
    booking.artisanNotes = dto.artisanNotes;
    await this.repo.save(booking);

    this.eventEmitter.emit(APP_EVENTS.BOOKING_DECLINED, {
      customerId: booking.customerId,
      artisanName:
        booking.artisanProfile.businessName ??
        `${booking.artisanProfile.user.firstname} ${booking.artisanProfile.user.lastname}`,
      scheduledDate: booking.scheduledDate,
      bookingId: booking.id,
    } as BookingDeclinedPayload);

    return { message: 'Booking declined.' };
  }

  /**
   * R2 edge case: once a linked Job exists and has progressed past PENDING
   * (i.e. the artisan has started work), cancelling the booking is blocked —
   * the job's own `PATCH /jobs/:id/cancel` is the correct path from that
   * point forward (documented in api-contract.md). If the linked job is
   * still PENDING (artisan hasn't started), cancelling the booking also
   * cancels the job so the two records never diverge.
   */
  async cancel(customerId: number, bookingId: number) {
    const booking = await this.loadOrFail(bookingId, [
      'artisanProfile',
      'artisanProfile.user',
      'customer',
    ]);
    if (booking.customerId !== customerId)
      throw new ForbiddenException('Access denied.');
    if (
      booking.status === BookingStatus.COMPLETED ||
      booking.status === BookingStatus.CANCELLED ||
      booking.status === BookingStatus.DECLINED ||
      booking.status === BookingStatus.EXPIRED ||
      booking.status === BookingStatus.NO_SHOW
    ) {
      throw new BadRequestException(
        `Cannot cancel a booking with status ${booking.status}.`,
      );
    }

    const linkedJob = await this.jobRepo.findOne({
      // Job.bookingId is a @RelationId (virtual, not a real column) —
      // filter via the relation object instead.
      where: { booking: { id: booking.id } },
    });
    if (linkedJob && linkedJob.status !== Status.PENDING) {
      throw new BadRequestException(
        "This booking's job has already started. Cancel it via the job's own cancel action instead.",
      );
    }

    const wasConfirmed = booking.status === BookingStatus.CONFIRMED;

    await this.dataSource.transaction(async (manager) => {
      const bookingRepo = manager.getRepository(Booking);
      const jobRepo = manager.getRepository(Job);
      const historyRepo = manager.getRepository(JobStatusHistory);

      booking.status = BookingStatus.CANCELLED;
      await bookingRepo.save(booking);

      if (linkedJob) {
        linkedJob.status = Status.CANCELLED;
        await jobRepo.save(linkedJob);
        await historyRepo.save(
          historyRepo.create({
            jobId: linkedJob.id,
            fromStatus: Status.PENDING,
            toStatus: Status.CANCELLED,
            changedBy: String(customerId),
            reason: 'Linked booking was cancelled by the customer',
          }),
        );
      }
    });

    if (wasConfirmed) {
      this.eventEmitter.emit(APP_EVENTS.BOOKING_CANCELLED, {
        artisanUserId: booking.artisanProfile.user.id,
        customerName: `${booking.customer.firstname} ${booking.customer.lastname}`,
        scheduledDate: booking.scheduledDate,
        bookingId: booking.id,
      } as BookingCancelledPayload);
    }

    return { message: 'Booking cancelled.' };
  }

  async complete(customerId: number, bookingId: number) {
    const booking = await this.loadOrFail(bookingId, [
      'artisanProfile',
      'artisanProfile.user',
    ]);
    if (booking.customerId !== customerId)
      throw new ForbiddenException('Access denied.');
    if (booking.status !== BookingStatus.CONFIRMED) {
      throw new BadRequestException(
        'Only CONFIRMED bookings can be marked as completed.',
      );
    }
    booking.status = BookingStatus.COMPLETED;
    await this.repo.save(booking);

    this.eventEmitter.emit(APP_EVENTS.BOOKING_COMPLETED, {
      artisanUserId: booking.artisanProfile.user.id,
      scheduledDate: booking.scheduledDate,
      bookingId: booking.id,
    } as BookingCompletedPayload);

    return { message: 'Booking marked as completed.' };
  }

  // ─── A6: no-show flag (both parties can independently coexist) ──────────────

  async flagNoShow(requestUserId: number, bookingId: number) {
    const booking = await this.loadOrFail(bookingId, [
      'artisanProfile',
      'artisanProfile.user',
      'customer',
    ]);
    const isCustomer = booking.customerId === requestUserId;
    const isArtisan = booking.artisanProfile?.user?.id === requestUserId;
    if (!isCustomer && !isArtisan) {
      // 403/404-equivalent: matches the existing GET /bookings/:id ownership
      // model (any other authenticated user is denied).
      throw new ForbiddenException('Access denied.');
    }
    if (booking.status !== BookingStatus.CONFIRMED) {
      throw new BadRequestException(
        `Only a CONFIRMED booking's appointment can be flagged as a no-show. This booking is ${booking.status}.`,
      );
    }

    // NFR (c): "has the scheduled end time passed" is evaluated server-side
    // in UTC, never against a client-supplied clock.
    const endInstant = this.toUtcInstant(
      booking.scheduledDate,
      booking.endTime,
    );
    if (Date.now() < endInstant.getTime()) {
      throw new BadRequestException(
        'This appointment has not ended yet — no-show can only be flagged after the scheduled end time.',
      );
    }

    const flaggedParty = isCustomer
      ? NoShowParty.ARTISAN
      : NoShowParty.CUSTOMER;
    const now = new Date();
    if (isCustomer) {
      booking.noShowByCustomerAt = now;
    } else {
      booking.noShowByArtisanAt = now;
    }
    // A6: dedicated NO_SHOW status — does not cascade to the linked job (a
    // no-show flag is a data point for the existing admin dispute channel,
    // not an automatic job-state decision).
    booking.status = BookingStatus.NO_SHOW;
    await this.repo.save(booking);

    const flaggedByName = isCustomer
      ? `${booking.customer.firstname} ${booking.customer.lastname}`
      : (booking.artisanProfile.businessName ??
        `${booking.artisanProfile.user.firstname} ${booking.artisanProfile.user.lastname}`);
    const recipientUserId = isCustomer
      ? booking.artisanProfile.user.id
      : booking.customerId;

    this.eventEmitter.emit(APP_EVENTS.BOOKING_NO_SHOW, {
      recipientUserId,
      flaggedByName,
      scheduledDate: booking.scheduledDate,
      bookingId: booking.id,
    } as BookingNoShowPayload);

    this.logger.log(
      `Booking ${booking.id} flagged NO_SHOW by ${flaggedParty} (user ${requestUserId})`,
    );

    return {
      message: `Marked as a no-show. ${flaggedParty === NoShowParty.ARTISAN ? 'The artisan' : 'The customer'} has been notified.`,
    };
  }

  // ─── A5: 24h expiry cron entry point ──────────────────────────────────────────

  /** Returns IDs of PENDING bookings whose 24h response window has elapsed. */
  async findExpiryCandidateIds(): Promise<number[]> {
    const cutoff = new Date(
      Date.now() - VARIABLES.BOOKING_EXPIRY_HOURS * 60 * 60 * 1000,
    );
    const rows = await this.repo.find({
      where: { status: BookingStatus.PENDING, createdAt: LessThan(cutoff) },
      select: ['id'],
    });
    return rows.map((r) => r.id);
  }

  /**
   * A5: idempotent, crash-tolerant single-booking expiry. The conditional
   * `UPDATE ... WHERE status = 'PENDING'` means a booking already expired
   * (or confirmed/declined) by a prior/concurrent run simply doesn't match —
   * running this twice for the same ID is a safe no-op the second time.
   */
  async expireBooking(bookingId: number): Promise<boolean> {
    const result = await this.repo
      .createQueryBuilder()
      .update(Booking)
      .set({ status: BookingStatus.EXPIRED })
      .where('id = :id AND status = :status', {
        id: bookingId,
        status: BookingStatus.PENDING,
      })
      .execute();

    const claimed = (result.affected ?? 0) > 0;
    if (!claimed) return false;

    const booking = await this.repo.findOne({ where: { id: bookingId } });
    if (booking) {
      this.eventEmitter.emit(APP_EVENTS.BOOKING_EXPIRED, {
        customerId: booking.customerId,
        scheduledDate: booking.scheduledDate,
        bookingId: booking.id,
      } as BookingExpiredPayload);
    }
    return true;
  }

  // ─── A7: reminder cron entry points ───────────────────────────────────────────

  /**
   * Candidate CONFIRMED bookings whose appointment instant falls within the
   * milestone's detection band (sized to the cron's 30-min polling interval)
   * and that haven't already received that milestone's reminder.
   */
  async findReminderCandidates(milestone: '24H' | '2H'): Promise<Booking[]> {
    const hours =
      milestone === '24H'
        ? VARIABLES.REMINDER_24H_HOURS
        : VARIABLES.REMINDER_2H_HOURS;
    const bandMs = VARIABLES.REMINDER_POLL_MINUTES * 60 * 1000;
    const now = Date.now();
    const windowStart = new Date(now + hours * 60 * 60 * 1000 - bandMs);
    const windowEnd = new Date(now + hours * 60 * 60 * 1000);
    const sentColumn =
      milestone === '24H' ? 'reminder_24h_sent_at' : 'reminder_2h_sent_at';

    return this.repo
      .createQueryBuilder('b')
      .leftJoinAndSelect('b.customer', 'customer')
      .leftJoinAndSelect('b.artisanProfile', 'artisanProfile')
      .leftJoinAndSelect('artisanProfile.user', 'artisanUser')
      .where('b.status = :status', { status: BookingStatus.CONFIRMED })
      .andWhere(`b.${sentColumn} IS NULL`)
      .andWhere(
        `(b.scheduled_date + b.start_time) >= :windowStart AND (b.scheduled_date + b.start_time) < :windowEnd`,
        { windowStart, windowEnd },
      )
      .getMany();
  }

  /**
   * A7: emits one reminder event per party (customer + artisan). Each
   * listener (in-app via `NotificationsService`, email via
   * `DomainMailListener`) independently checks that recipient's per-event
   * notification preference before actually sending — this method fires
   * regardless, and preference suppression happens downstream, exactly like
   * every other booking event in this codebase.
   *
   * The idempotency flag is stamped unconditionally after the emit (event
   * emission is synchronous/in-process and doesn't itself fail); genuine
   * delivery failures inside a listener are caught and logged by that
   * listener, never rolled back into re-sending here (NFR (b), (e)).
   */
  async sendReminder(booking: Booking, milestone: '24H' | '2H'): Promise<void> {
    const eventName =
      milestone === '24H'
        ? APP_EVENTS.BOOKING_REMINDER_24H
        : APP_EVENTS.BOOKING_REMINDER_2H;

    const recipients: { userId: number; role: Role }[] = [
      { userId: booking.customerId, role: Role.CUSTOMER },
      { userId: booking.artisanProfile.user.id, role: Role.ARTISAN },
    ];

    for (const r of recipients) {
      this.eventEmitter.emit(eventName, {
        recipientUserId: r.userId,
        recipientRole: r.role,
        scheduledDate: booking.scheduledDate,
        startTime: booking.startTime,
        bookingId: booking.id,
        milestone,
      } as BookingReminderPayload);
    }

    const sentColumn =
      milestone === '24H' ? 'reminder24hSentAt' : 'reminder2hSentAt';
    booking[sentColumn] = new Date();
    await this.repo.save(booking);
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  private async list(
    filter: { customerId?: number; artisanProfileId?: number },
    query: GetBookingsQueryDto,
  ) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const qb = this.repo
      .createQueryBuilder('b')
      .leftJoinAndSelect('b.customer', 'customer')
      .leftJoinAndSelect('b.artisanProfile', 'artisanProfile')
      .leftJoinAndSelect('artisanProfile.user', 'artisanUser')
      .leftJoinAndSelect('b.availabilitySlot', 'availabilitySlot')
      .leftJoinAndSelect('b.service', 'service')
      .orderBy('b.scheduledDate', 'DESC');

    // customerId/artisanProfileId are @RelationId (virtual, not real
    // columns) — query builder's alias.propertyName resolution doesn't
    // cover them either; use the raw snake_case column names instead,
    // consistent with the A4 overlap-check query above.
    if (filter.customerId)
      qb.andWhere('b.customer_id = :id', { id: filter.customerId });
    if (filter.artisanProfileId)
      qb.andWhere('b.artisan_profile_id = :id', {
        id: filter.artisanProfileId,
      });
    if (query.status)
      qb.andWhere('b.status = :status', { status: query.status });

    const [records, total] = await qb
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    const data = await Promise.all(records.map((r) => this.toResponseDto(r)));

    return {
      message: 'Bookings retrieved.',
      data,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      } as Pagination,
    };
  }

  private async toResponseDto(booking: Booking): Promise<BookingResponseDto> {
    const job = await this.jobRepo.findOne({
      // Job.bookingId is a @RelationId (virtual, not a real column) —
      // filter via the relation object instead.
      where: { booking: { id: booking.id } },
      select: ['id'],
    });
    const dto = plainToInstance(BookingResponseDto, booking, {
      excludeExtraneousValues: true,
    });
    dto.jobId = job?.id;
    return dto;
  }

  private async loadOrFail(
    id: number,
    relations: string[] = [
      'customer',
      'artisanProfile',
      'artisanProfile.user',
      'availabilitySlot',
      'service',
    ],
  ): Promise<Booking> {
    const booking = await this.repo.findOne({ where: { id }, relations });
    if (!booking) throw new NotFoundException('Booking not found.');
    return booking;
  }

  private assertArtisanOwner(booking: Booking, artisanUserId: number): void {
    if (booking.artisanProfile?.user?.id !== artisanUserId) {
      throw new ForbiddenException('Access denied.');
    }
  }

  /** "HH:MM" + UTC calendar date → a real UTC Date instant (NFR (c)). */
  private toUtcInstant(scheduledDate: string, time: string): Date {
    return new Date(`${scheduledDate}T${time}:00.000Z`);
  }

  private addMinutes(time: string, minutes: number): string {
    const [h, m] = time.split(':').map(Number);
    let total = h * 60 + m + minutes;
    total = Math.min(total, 23 * 60 + 59);
    const hh = String(Math.floor(total / 60)).padStart(2, '0');
    const mm = String(total % 60).padStart(2, '0');
    return `${hh}:${mm}`;
  }

  private guessMimeFromUrl(url: string): string {
    const ext = url.slice(url.lastIndexOf('.')).toLowerCase();
    return MIME_BY_EXT[ext] ?? 'image/jpeg';
  }
}
