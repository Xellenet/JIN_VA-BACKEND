import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { plainToInstance } from 'class-transformer';
import { Repository } from 'typeorm';
import { Dispute } from './entities/dispute.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { CreateDisputeDto } from './dto/create-dispute.dto';
import { GetDisputesQueryDto } from './dto/get-disputes-query.dto';
import { ResolveDisputeDto, CloseDisputeDto } from './dto/resolve-dispute.dto';
import { DisputeResponseDto } from './dto/dispute-response.dto';
import { BookingStatus, DisputeStatus } from '@common/types/enums';

@Injectable()
export class DisputesService {
  constructor(
    @InjectRepository(Dispute)
    private readonly repo: Repository<Dispute>,
    @InjectRepository(Booking)
    private readonly bookingRepo: Repository<Booking>,
  ) {}

  // ─── User-facing ────────────────────────────────────────────────────────────

  async raise(userId: number, dto: CreateDisputeDto) {
    const booking = await this.bookingRepo.findOne({
      where: { id: dto.bookingId },
      relations: ['customer', 'artisanProfile', 'artisanProfile.user'],
    });
    if (!booking) throw new NotFoundException('Booking not found.');

    const isCustomer = booking.customer.id === userId;
    const isArtisan  = booking.artisanProfile.user.id === userId;

    if (!isCustomer && !isArtisan) {
      throw new ForbiddenException('You are not a participant of this booking.');
    }

    const disputeableStatuses: BookingStatus[] = [BookingStatus.COMPLETED, BookingStatus.CANCELLED];
    if (!disputeableStatuses.includes(booking.status)) {
      throw new BadRequestException(
        `Disputes can only be raised on COMPLETED or CANCELLED bookings (current: ${booking.status}).`,
      );
    }

    const existing = await this.repo.findOne({
      where: { bookingId: dto.bookingId, raisedById: userId },
    });
    if (existing) {
      throw new BadRequestException('You have already raised a dispute for this booking.');
    }

    const dispute = await this.repo.save(
      this.repo.create({
        booking,
        bookingId: dto.bookingId,
        raisedBy: { id: userId } as any,
        raisedById: userId,
        reason: dto.reason,
        status: DisputeStatus.OPEN,
      }),
    );

    return {
      message: 'Dispute raised. Our team will review and respond within 48 hours.',
      data: this.toDto(dispute),
    };
  }

  async getMyDisputes(userId: number) {
    const disputes = await this.repo.find({
      where: { raisedById: userId },
      relations: ['booking', 'raisedBy', 'resolvedBy'],
      order: { createdAt: 'DESC' },
    });

    return {
      message: 'Your disputes retrieved.',
      data: disputes.map(d => this.toDto(d)),
    };
  }

  async getMyDispute(userId: number, disputeId: number) {
    const dispute = await this.repo.findOne({
      where: { id: disputeId, raisedById: userId },
      relations: ['booking', 'raisedBy', 'resolvedBy'],
    });
    if (!dispute) throw new NotFoundException('Dispute not found.');

    return { message: 'Dispute retrieved.', data: this.toDto(dispute) };
  }

  // ─── Admin-facing ────────────────────────────────────────────────────────────

  async findAll(query: GetDisputesQueryDto) {
    const page  = query.page  ?? 1;
    const limit = query.limit ?? 20;

    const qb = this.repo
      .createQueryBuilder('d')
      .leftJoinAndSelect('d.booking',     'booking')
      .leftJoinAndSelect('d.raisedBy',    'raisedBy')
      .leftJoinAndSelect('d.resolvedBy',  'resolvedBy')
      .orderBy('d.createdAt', 'DESC');

    if (query.status) qb.andWhere('d.status = :status', { status: query.status });

    const [disputes, total] = await qb
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return {
      message: 'Disputes retrieved.',
      data: disputes.map(d => this.toDto(d)),
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(id: number) {
    const dispute = await this.repo.findOne({
      where: { id },
      relations: ['booking', 'booking.customer', 'booking.artisanProfile', 'raisedBy', 'resolvedBy'],
    });
    if (!dispute) throw new NotFoundException('Dispute not found.');
    return { message: 'Dispute retrieved.', data: this.toDto(dispute) };
  }

  async startReview(adminId: number, id: number) {
    const dispute = await this.loadOrFail(id);
    if (dispute.status !== DisputeStatus.OPEN) {
      throw new BadRequestException(`Cannot start review — current status is ${dispute.status}.`);
    }
    dispute.status = DisputeStatus.UNDER_REVIEW;
    await this.repo.save(dispute);
    return { message: 'Dispute is now UNDER_REVIEW.' };
  }

  async resolve(adminId: number, id: number, dto: ResolveDisputeDto) {
    const dispute = await this.loadOrFail(id);
    if (dispute.status === DisputeStatus.RESOLVED || dispute.status === DisputeStatus.CLOSED) {
      throw new BadRequestException(`Dispute is already ${dispute.status}.`);
    }

    dispute.status       = DisputeStatus.RESOLVED;
    dispute.resolution   = dto.resolution;
    dispute.resolvedById = adminId;
    dispute.resolvedBy   = { id: adminId } as any;
    dispute.resolvedAt   = new Date();
    if (dto.adminNotes) dispute.adminNotes = dto.adminNotes;

    await this.repo.save(dispute);
    return { message: 'Dispute resolved.' };
  }

  async close(adminId: number, id: number, dto: CloseDisputeDto) {
    const dispute = await this.loadOrFail(id);
    if (dispute.status === DisputeStatus.CLOSED) {
      throw new BadRequestException('Dispute is already closed.');
    }

    dispute.status       = DisputeStatus.CLOSED;
    dispute.resolvedById = adminId;
    dispute.resolvedBy   = { id: adminId } as any;
    dispute.resolvedAt   = new Date();
    if (dto.adminNotes) dispute.adminNotes = dto.adminNotes;

    await this.repo.save(dispute);
    return { message: 'Dispute closed.' };
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private async loadOrFail(id: number): Promise<Dispute> {
    const dispute = await this.repo.findOne({ where: { id } });
    if (!dispute) throw new NotFoundException('Dispute not found.');
    return dispute;
  }

  private toDto(dispute: Dispute): DisputeResponseDto {
    return plainToInstance(DisputeResponseDto, dispute, { excludeExtraneousValues: true });
  }
}
