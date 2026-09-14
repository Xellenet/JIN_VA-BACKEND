import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '@users/entities/user.entity';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { Job } from '@jobs/entities/job.entity';
import { JobApplication } from '@jobs/entities/job-application.entity';
import { ArtisanVerification } from '../verification/entities/artisan-verification.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { JobsService } from '@jobs/jobs.service';
import {
  AdminUsersQueryDto,
  AdminJobsQueryDto,
  AdminBookingsQueryDto,
  AdminSearchQueryDto,
  BanUserDto,
  SuspendUserDto,
} from './dto/admin-query.dto';
import { Dispute } from '../disputes/entities/dispute.entity';
import { AdminAuditService } from '../admin-audit/admin-audit.service';
import { PaymentsService } from '../payments/payments.service';
import {
  AdminActionTarget,
  AdminActionType,
  AdminUserStatus,
  BookingStatus,
  DisputeCategory,
  Role,
  Status,
  VerificationStatus,
} from '@common/types/enums';

type Pagination = {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

@Injectable()
export class AdminService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepo: Repository<User>,
    @InjectRepository(ArtisanProfile)
    private readonly profileRepo: Repository<ArtisanProfile>,
    @InjectRepository(Job)
    private readonly jobsRepo: Repository<Job>,
    @InjectRepository(JobApplication)
    private readonly applicationsRepo: Repository<JobApplication>,
    @InjectRepository(ArtisanVerification)
    private readonly verificationsRepo: Repository<ArtisanVerification>,
    @InjectRepository(Booking)
    private readonly bookingsRepo: Repository<Booking>,
    /** AT6: the third entity type the cross-entity admin search covers. */
    @InjectRepository(Dispute)
    private readonly disputesRepo: Repository<Dispute>,
    private readonly jobsService: JobsService,
    /** AT5: ban/unban and suspend/activate each write an audit row. */
    private readonly auditService: AdminAuditService,
    /** AT9: exposes the platform fee percentage the backend actually applies. */
    private readonly paymentsService: PaymentsService,
  ) {}

  // ─── Users ───────────────────────────────────────────────────────────────────

  async listUsers(query: AdminUsersQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const qb = this.usersRepo
      .createQueryBuilder('u')
      .orderBy('u.createdAt', 'DESC');

    if (query.role) qb.andWhere('u.role = :role', { role: query.role });

    // AT3: `status` distinguishes suspended from banned and takes precedence
    // over the older boolean-only `isBanned` filter, which is kept working for
    // existing callers.
    if (query.status) {
      switch (query.status) {
        case AdminUserStatus.BANNED:
          qb.andWhere('u.isBanned = true');
          break;
        case AdminUserStatus.SUSPENDED:
          // A banned account is reported as BANNED, never as SUSPENDED, even
          // when both flags are set — so the two filters partition the set.
          qb.andWhere('u.isSuspended = true').andWhere('u.isBanned = false');
          break;
        case AdminUserStatus.ACTIVE:
          qb.andWhere('u.isBanned = false').andWhere('u.isSuspended = false');
          break;
      }
    } else if (query.isBanned !== undefined) {
      qb.andWhere('u.isBanned = :isBanned', { isBanned: query.isBanned });
    }

    // AT3: join-date filter. `joinedTo` is treated as inclusive of the whole
    // day when a bare date is supplied, so "up to 31 Aug" includes 31 Aug.
    if (query.joinedFrom) {
      qb.andWhere('u.createdAt >= :joinedFrom', {
        joinedFrom: new Date(query.joinedFrom),
      });
    }
    if (query.joinedTo) {
      qb.andWhere('u.createdAt <= :joinedTo', {
        joinedTo: this.endOfDayIfBareDate(query.joinedTo),
      });
    }

    const [users, total] = await qb
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return {
      message: 'Users retrieved.',
      data: users.map((u) => this.sanitizeUser(u)),
      pagination: this.paginate(total, page, limit),
    };
  }

  async getUser(id: number) {
    const user = await this.usersRepo.findOne({
      where: { id },
      relations: ['artisanProfile', 'customerProfile'],
    });
    if (!user) throw new NotFoundException('User not found.');
    return { message: 'User retrieved.', data: this.sanitizeUser(user) };
  }

  /**
   * AT2: the acting admin is now captured on the row (`bannedById`) and in the
   * audit log. Before this round only `bannedAt` was stored, so a ban was
   * completely unattributable after the fact.
   */
  async banUser(admin: User, userId: number, dto?: BanUserDto) {
    if (admin.id === userId)
      throw new BadRequestException('You cannot ban yourself.');
    const user = await this.loadUserOrFail(userId);
    if (user.isBanned) throw new BadRequestException('User is already banned.');
    user.isBanned = true;
    user.bannedAt = new Date();
    user.bannedById = admin.id;
    await this.usersRepo.save(user);

    await this.recordUserAction(
      admin,
      user,
      AdminActionType.USER_BAN,
      dto?.reason ?? null,
    );
    return { message: `User ${user.email} has been banned.` };
  }

  async unbanUser(admin: User, userId: number) {
    const user = await this.loadUserOrFail(userId);
    if (!user.isBanned)
      throw new BadRequestException('User is not currently banned.');
    user.isBanned = false;
    // `null`, not `undefined`: TypeORM's `save()` omits `undefined` properties
    // from the UPDATE, so these two columns kept the previous ban's timestamp
    // and actor forever and an unbanned account still read as banned-at-X.
    user.bannedAt = null;
    user.bannedById = null;
    await this.usersRepo.save(user);

    await this.recordUserAction(admin, user, AdminActionType.USER_UNBAN, null);
    return { message: `User ${user.email} has been unbanned.` };
  }

  /**
   * AT3: reversible suspension, distinct from the permanent ban.
   *
   * Behaviour (Open Question 4, resolved): a suspended user **can still log
   * in** — `JwtStrategy` blocks only `isBanned` — but cannot transact (no new
   * bookings, jobs, applications or messages; enforced by `NotSuspendedGuard`
   * on those routes) and is excluded from public artisan search. Indefinite
   * until an admin reactivates; there is deliberately no duration.
   *
   * Self-suspension is blocked, matching the existing self-ban guard — an
   * admin locking themselves out of the tools they'd need to undo it is not a
   * recoverable state.
   */
  async suspendUser(admin: User, userId: number, dto: SuspendUserDto) {
    if (admin.id === userId)
      throw new BadRequestException('You cannot suspend yourself.');
    const user = await this.loadUserOrFail(userId);
    if (user.isSuspended)
      throw new BadRequestException('User is already suspended.');
    if (user.isBanned)
      throw new BadRequestException(
        'User is permanently banned, which is stricter than a suspension. Unban them first if you meant to suspend instead.',
      );

    user.isSuspended = true;
    user.suspendedAt = new Date();
    user.suspendedById = admin.id;
    user.suspensionReason = dto.reason;
    await this.usersRepo.save(user);

    await this.recordUserAction(
      admin,
      user,
      AdminActionType.USER_SUSPEND,
      dto.reason,
    );
    return {
      message: `User ${user.email} has been suspended. They can still sign in but cannot transact or be found in search until reactivated.`,
    };
  }

  /**
   * AT3: full reactivation — every restriction the suspension applied is
   * lifted, and every trace of it is cleared off the row.
   *
   * The clears are `null`, not `undefined`. TypeORM's `save()` treats an
   * `undefined` property as "not provided" and leaves it out of the UPDATE
   * entirely, so reactivation used to flip `isSuspended` to false while
   * leaving `suspendedAt`, `suspendedById` and `suspensionReason` populated.
   * The account worked again, but every admin surface reading those fields
   * still showed it as suspended-on-X-because-Y — a reactivated user carrying
   * a live-looking suspension reason indefinitely.
   */
  async activateUser(admin: User, userId: number) {
    const user = await this.loadUserOrFail(userId);
    if (!user.isSuspended)
      throw new BadRequestException('User is not currently suspended.');

    user.isSuspended = false;
    user.suspendedAt = null;
    user.suspendedById = null;
    user.suspensionReason = null;
    await this.usersRepo.save(user);

    await this.recordUserAction(
      admin,
      user,
      AdminActionType.USER_ACTIVATE,
      null,
    );
    return { message: `User ${user.email} has been reactivated.` };
  }

  // ─── Jobs ────────────────────────────────────────────────────────────────────

  async listJobs(query: AdminJobsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const qb = this.jobsRepo
      .createQueryBuilder('j')
      .withDeleted()
      .leftJoinAndSelect('j.customer', 'customer')
      .leftJoinAndSelect('j.service', 'service')
      .orderBy('j.createdAt', 'DESC');

    if (query.status)
      qb.andWhere('j.status = :status', { status: query.status });

    const [jobs, total] = await qb
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return {
      message: 'Jobs retrieved.',
      data: jobs,
      pagination: this.paginate(total, page, limit),
    };
  }

  async forceExpireJob(jobId: number) {
    await this.jobsService.expireJob(jobId);
    return { message: `Job ${jobId} has been expired.` };
  }

  // ─── A6: bookings (minimal read path for the admin dispute-resolution channel) ─

  async listBookings(query: AdminBookingsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const qb = this.bookingsRepo
      .createQueryBuilder('b')
      .leftJoinAndSelect('b.customer', 'customer')
      .leftJoinAndSelect('b.artisanProfile', 'artisanProfile')
      .leftJoinAndSelect('artisanProfile.user', 'artisanUser')
      .leftJoinAndSelect('b.service', 'service')
      .orderBy('b.createdAt', 'DESC');

    if (query.status)
      qb.andWhere('b.status = :status', { status: query.status });
    // artisanProfileId/customerId on Booking are @RelationId (virtual, not
    // real columns) — query builder's alias.propertyName resolution
    // doesn't cover them; use the raw snake_case column names instead.
    if (query.artisanProfileId)
      qb.andWhere('b.artisan_profile_id = :artisanProfileId', {
        artisanProfileId: query.artisanProfileId,
      });
    if (query.customerId)
      qb.andWhere('b.customer_id = :customerId', {
        customerId: query.customerId,
      });

    const [bookings, total] = await qb
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return {
      message: 'Bookings retrieved.',
      data: bookings,
      pagination: this.paginate(total, page, limit),
    };
  }

  async getBooking(id: number) {
    const booking = await this.bookingsRepo.findOne({
      where: { id },
      relations: [
        'customer',
        'artisanProfile',
        'artisanProfile.user',
        'service',
      ],
    });
    if (!booking) throw new NotFoundException('Booking not found.');
    return { message: 'Booking retrieved.', data: booking };
  }

  // ─── Artisans ────────────────────────────────────────────────────────────────

  async listArtisans(page = 1, limit = 20) {
    const qb = this.profileRepo
      .createQueryBuilder('ap')
      .innerJoinAndSelect('ap.user', 'user')
      .leftJoinAndSelect('ap.services', 'services')
      .orderBy('ap.createdAt', 'DESC');

    const [profiles, total] = await qb
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return {
      message: 'Artisans retrieved.',
      data: profiles,
      pagination: this.paginate(total, page, limit),
    };
  }

  // ─── Stats ───────────────────────────────────────────────────────────────────

  async getStats() {
    const [
      totalUsers,
      totalArtisans,
      totalCustomers,
      bannedUsers,
      totalJobs,
      openJobs,
      pendingVerifications,
      approvedVerifications,
      totalBookings,
      confirmedBookings,
    ] = await Promise.all([
      this.usersRepo.count(),
      this.usersRepo.count({ where: { role: Role.ARTISAN } }),
      this.usersRepo.count({ where: { role: Role.CUSTOMER } }),
      this.usersRepo.count({ where: { isBanned: true } }),
      this.jobsRepo.count(),
      this.jobsRepo.count({ where: { status: Status.OPEN } }),
      this.verificationsRepo.count({
        where: { status: VerificationStatus.PENDING },
      }),
      this.verificationsRepo.count({
        where: { status: VerificationStatus.APPROVED },
      }),
      this.bookingsRepo.count(),
      this.bookingsRepo.count({ where: { status: BookingStatus.CONFIRMED } }),
    ]);

    return {
      message: 'Platform statistics retrieved.',
      data: {
        users: {
          total: totalUsers,
          artisans: totalArtisans,
          customers: totalCustomers,
          banned: bannedUsers,
        },
        jobs: { total: totalJobs, open: openJobs },
        verifications: {
          pending: pendingVerifications,
          approved: approvedVerifications,
        },
        bookings: { total: totalBookings, confirmed: confirmedBookings },
      },
    };
  }

  // ─── AT6: cross-entity admin search ───────────────────────────────────────────

  /**
   * AT6: one admin-only lookup across the three entity types an admin actually
   * needs to jump to — users, jobs and disputes — by the identifiers they
   * realistically have (name, email, numeric id).
   *
   * Scope boundary, deliberate: this is **not** a general full-text search
   * over messages, reviews or payment records. It crosses user boundaries by
   * design, which is exactly why the route is admin-only and enforced
   * server-side by `RolesGuard` on `AdminController`, not by the frontend
   * simply not offering it.
   *
   * Each entity type is capped independently (`limit`, max 25) so one noisy
   * match set can't crowd out the others.
   */
  async search(query: AdminSearchQueryDto) {
    const term = query.q.trim();
    const limit = query.limit ?? 5;
    const like = `%${term.toLowerCase()}%`;
    const numeric = /^\d+$/.test(term) ? Number(term) : null;

    const usersQb = this.usersRepo
      .createQueryBuilder('u')
      .where(
        "(LOWER(u.firstname || ' ' || u.lastname) LIKE :like OR LOWER(u.email) LIKE :like)",
        { like },
      );
    if (numeric !== null) {
      usersQb.orWhere('u.id = :numeric', { numeric });
    }
    usersQb.orderBy('u.createdAt', 'DESC').take(limit);

    const jobsQb = this.jobsRepo
      .createQueryBuilder('j')
      .withDeleted()
      .leftJoinAndSelect('j.customer', 'customer')
      .leftJoinAndSelect('j.service', 'service')
      .where('(LOWER(j.title) LIKE :like OR LOWER(j.location) LIKE :like)', {
        like,
      });
    if (numeric !== null) {
      jobsQb.orWhere('j.id = :numeric', { numeric });
    }
    jobsQb.orderBy('j.createdAt', 'DESC').take(limit);

    const disputesQb = this.disputesRepo
      .createQueryBuilder('d')
      .leftJoinAndSelect('d.raisedBy', 'raisedBy')
      .where(
        "(LOWER(raisedBy.firstname || ' ' || raisedBy.lastname) LIKE :like OR LOWER(raisedBy.email) LIKE :like)",
        { like },
      );
    if (numeric !== null) {
      disputesQb
        .orWhere('d.id = :numeric', { numeric })
        .orWhere('d.booking_id = :numeric', { numeric });
    }
    disputesQb.orderBy('d.createdAt', 'DESC').take(limit);

    const [users, jobs, disputes] = await Promise.all([
      usersQb.getMany(),
      jobsQb.getMany(),
      disputesQb.getMany(),
    ]);

    return {
      message:
        users.length + jobs.length + disputes.length > 0
          ? 'Search results retrieved.'
          : 'No users, jobs or disputes match that search.',
      data: {
        query: term,
        users: users.map((u) => ({
          id: u.id,
          name: `${u.firstname} ${u.lastname}`,
          email: u.email,
          role: u.role,
          status: this.accountStatus(u),
          createdAt: u.createdAt,
        })),
        jobs: jobs.map((j) => ({
          id: j.id,
          title: j.title ?? null,
          status: j.status,
          location: j.location,
          service: j.service
            ? { id: j.service.id, name: j.service.name }
            : null,
          customer: j.customer
            ? {
                id: j.customer.id,
                name: `${j.customer.firstname} ${j.customer.lastname}`,
              }
            : null,
          deletedAt: j.deletedAt ?? null,
          createdAt: j.createdAt,
        })),
        disputes: disputes.map((d) => ({
          id: d.id,
          bookingId: d.bookingId,
          status: d.status,
          category: d.category ?? DisputeCategory.OTHER,
          outcome: d.outcome ?? null,
          raisedBy: d.raisedBy
            ? {
                id: d.raisedBy.id,
                name: `${d.raisedBy.firstname} ${d.raisedBy.lastname}`,
              }
            : null,
          createdAt: d.createdAt,
        })),
        counts: {
          users: users.length,
          jobs: jobs.length,
          disputes: disputes.length,
        },
      },
    };
  }

  // ─── AT9: platform configuration the frontend must display truthfully ────────

  /**
   * AT9: the platform fee percentage the backend **actually applies** in
   * `PaymentsService.holdPayment`. The admin Settings screen displayed a
   * hardcoded 15 against a backend default of 5 — a 3× disagreement an admin
   * could reasonably have acted on.
   *
   * Read-only: making the fee runtime-configurable has retroactive-pricing
   * consequences for in-flight jobs and is deliberately out of scope (Open
   * Question 11, resolved).
   */
  getPlatformConfig() {
    return {
      message: 'Platform configuration retrieved.',
      data: {
        platformFeePercent: this.paymentsService.getPlatformFeePercent(),
        /** Tells the frontend to render the field read-only rather than editable. */
        platformFeeEditable: false,
        currency: 'GHS',
      },
    };
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  /** AT3: the single derivation of account status, used by search and reads. */
  private accountStatus(user: User): AdminUserStatus {
    if (user.isBanned) return AdminUserStatus.BANNED;
    if (user.isSuspended) return AdminUserStatus.SUSPENDED;
    return AdminUserStatus.ACTIVE;
  }

  /**
   * A bare `YYYY-MM-DD` parses as midnight UTC, which would exclude everything
   * that happened *on* the end date. Push it to the end of that day.
   */
  private endOfDayIfBareDate(value: string): Date {
    const parsed = new Date(value);
    if (/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
      parsed.setUTCHours(23, 59, 59, 999);
    }
    return parsed;
  }

  /** AT5: one audit row per account action, with the target snapshotted. */
  private async recordUserAction(
    admin: User,
    target: User,
    action: AdminActionType,
    reason: string | null,
  ): Promise<void> {
    await this.auditService.record({
      action,
      targetType: AdminActionTarget.USER,
      targetId: target.id,
      targetLabel: `${target.firstname} ${target.lastname} (${target.email})`,
      reason,
      actorId: admin.id,
      actorName: `${admin.firstname} ${admin.lastname}`,
      actorEmail: admin.email,
      metadata: { role: target.role },
    });
  }

  private async loadUserOrFail(id: number): Promise<User> {
    const user = await this.usersRepo.findOne({ where: { id } });
    if (!user) throw new NotFoundException('User not found.');
    return user;
  }

  private sanitizeUser(user: User) {
    const { password: _password, ...safe } = user;
    // AT3: one derived field so every surface that displays account state
    // agrees, instead of each one re-deriving BANNED-wins-over-SUSPENDED.
    return { ...safe, accountStatus: this.accountStatus(user) };
  }

  private paginate(total: number, page: number, limit: number): Pagination {
    return { total, page, limit, totalPages: Math.ceil(total / limit) };
  }
}
