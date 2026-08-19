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
import { AdminUsersQueryDto, AdminJobsQueryDto } from './dto/admin-query.dto';
import { VerificationStatus } from '@common/types/enums';

type Pagination = { total: number; page: number; limit: number; totalPages: number };

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
    private readonly jobsService: JobsService,
  ) {}

  // ─── Users ───────────────────────────────────────────────────────────────────

  async listUsers(query: AdminUsersQueryDto) {
    const page  = query.page  ?? 1;
    const limit = query.limit ?? 20;

    const qb = this.usersRepo
      .createQueryBuilder('u')
      .orderBy('u.createdAt', 'DESC');

    if (query.role)                    qb.andWhere('u.role = :role', { role: query.role });
    if (query.isBanned !== undefined)  qb.andWhere('u.isBanned = :isBanned', { isBanned: query.isBanned });

    const [users, total] = await qb.skip((page - 1) * limit).take(limit).getManyAndCount();

    return {
      message: 'Users retrieved.',
      data: users.map(u => this.sanitizeUser(u)),
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

  async banUser(adminId: number, userId: number) {
    if (adminId === userId) throw new BadRequestException('You cannot ban yourself.');
    const user = await this.loadUserOrFail(userId);
    if (user.isBanned) throw new BadRequestException('User is already banned.');
    user.isBanned = true;
    user.bannedAt = new Date();
    await this.usersRepo.save(user);
    return { message: `User ${user.email} has been banned.` };
  }

  async unbanUser(userId: number) {
    const user = await this.loadUserOrFail(userId);
    if (!user.isBanned) throw new BadRequestException('User is not currently banned.');
    user.isBanned = false;
    user.bannedAt = undefined;
    await this.usersRepo.save(user);
    return { message: `User ${user.email} has been unbanned.` };
  }

  // ─── Jobs ────────────────────────────────────────────────────────────────────

  async listJobs(query: AdminJobsQueryDto) {
    const page  = query.page  ?? 1;
    const limit = query.limit ?? 20;

    const qb = this.jobsRepo
      .createQueryBuilder('j')
      .withDeleted()
      .leftJoinAndSelect('j.customer', 'customer')
      .leftJoinAndSelect('j.service', 'service')
      .orderBy('j.createdAt', 'DESC');

    if (query.status) qb.andWhere('j.status = :status', { status: query.status });

    const [jobs, total] = await qb.skip((page - 1) * limit).take(limit).getManyAndCount();

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

  // ─── Artisans ────────────────────────────────────────────────────────────────

  async listArtisans(page = 1, limit = 20) {
    const qb = this.profileRepo
      .createQueryBuilder('ap')
      .innerJoinAndSelect('ap.user', 'user')
      .leftJoinAndSelect('ap.services', 'services')
      .orderBy('ap.createdAt', 'DESC');

    const [profiles, total] = await qb.skip((page - 1) * limit).take(limit).getManyAndCount();

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
      this.usersRepo.count({ where: { role: 'ARTISAN' as any } }),
      this.usersRepo.count({ where: { role: 'CUSTOMER' as any } }),
      this.usersRepo.count({ where: { isBanned: true } }),
      this.jobsRepo.count(),
      this.jobsRepo.count({ where: { status: 'OPEN' as any } }),
      this.verificationsRepo.count({ where: { status: VerificationStatus.PENDING } }),
      this.verificationsRepo.count({ where: { status: VerificationStatus.APPROVED } }),
      this.bookingsRepo.count(),
      this.bookingsRepo.count({ where: { status: 'CONFIRMED' as any } }),
    ]);

    return {
      message: 'Platform statistics retrieved.',
      data: {
        users: { total: totalUsers, artisans: totalArtisans, customers: totalCustomers, banned: bannedUsers },
        jobs:  { total: totalJobs, open: openJobs },
        verifications: { pending: pendingVerifications, approved: approvedVerifications },
        bookings: { total: totalBookings, confirmed: confirmedBookings },
      },
    };
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private async loadUserOrFail(id: number): Promise<User> {
    const user = await this.usersRepo.findOne({ where: { id } });
    if (!user) throw new NotFoundException('User not found.');
    return user;
  }

  private sanitizeUser(user: User) {
    const { password, ...safe } = user as any;
    return safe;
  }

  private paginate(total: number, page: number, limit: number): Pagination {
    return { total, page, limit, totalPages: Math.ceil(total / limit) };
  }
}
