import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { plainToInstance } from 'class-transformer';
import { Repository } from 'typeorm';
import { Booking } from './entities/booking.entity';
import { CreateBookingDto } from './dto/create-booking.dto';
import { RespondBookingDto } from './dto/respond-booking.dto';
import { GetBookingsQueryDto } from './dto/get-bookings-query.dto';
import { BookingResponseDto } from './dto/booking-response.dto';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { ArtisanAvailability } from '../availability/entities/artisan-availability.entity';
import { BookingStatus } from '@common/types/enums';
import { APP_EVENTS } from '@common/events/app.events';
import type {
  BookingCancelledPayload,
  BookingCompletedPayload,
  BookingConfirmedPayload,
  BookingDeclinedPayload,
  BookingReceivedPayload,
} from '@common/events/app.events';

type Pagination = { total: number; page: number; limit: number; totalPages: number };

@Injectable()
export class BookingsService {
  constructor(
    @InjectRepository(Booking)
    private readonly repo: Repository<Booking>,
    @InjectRepository(ArtisanProfile)
    private readonly profileRepo: Repository<ArtisanProfile>,
    @InjectRepository(ArtisanAvailability)
    private readonly slotRepo: Repository<ArtisanAvailability>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async create(customerId: number, dto: CreateBookingDto) {
    const profile = await this.profileRepo.findOne({
      where: { id: dto.artisanProfileId },
      relations: ['user'],
    });
    if (!profile) throw new NotFoundException('Artisan profile not found.');

    let slot: ArtisanAvailability | undefined;
    if (dto.availabilitySlotId) {
      const found = await this.slotRepo.findOne({
        where: { id: dto.availabilitySlotId, artisanProfileId: dto.artisanProfileId, isActive: true },
      });
      if (!found) throw new NotFoundException('Availability slot not found or inactive.');
      slot = found;
    }

    if (dto.startTime >= dto.endTime) {
      throw new BadRequestException('endTime must be after startTime.');
    }

    const booking = this.repo.create({
      customer:          { id: customerId } as any,
      artisanProfile:    profile,
      artisanProfileId:  profile.id,
      availabilitySlot:  slot,
      availabilitySlotId: slot?.id,
      scheduledDate:     dto.scheduledDate,
      startTime:         dto.startTime,
      endTime:           dto.endTime,
      notes:             dto.notes,
      agreedPrice:       dto.agreedPrice,
      currency:          dto.currency ?? 'GHS',
    });

    const saved = await this.repo.save(booking);
    const loaded = await this.loadOrFail(saved.id);

    this.eventEmitter.emit(APP_EVENTS.BOOKING_RECEIVED, {
      artisanUserId: profile.user.id,
      customerName:  `${loaded.customer.firstname} ${loaded.customer.lastname}`,
      scheduledDate: dto.scheduledDate,
      bookingId:     saved.id,
    } as BookingReceivedPayload);

    return {
      message: 'Booking request sent. Awaiting artisan confirmation.',
      data: plainToInstance(BookingResponseDto, loaded, { excludeExtraneousValues: true }),
    };
  }

  async getMyBookings(customerId: number, query: GetBookingsQueryDto) {
    return this.list({ customerId }, query);
  }

  async getArtisanBookings(artisanUserId: number, query: GetBookingsQueryDto) {
    const profile = await this.profileRepo.findOne({ where: { user: { id: artisanUserId } } });
    if (!profile) throw new NotFoundException('Artisan profile not found.');
    return this.list({ artisanProfileId: profile.id }, query);
  }

  async findOne(bookingId: number, requestUserId: number) {
    const booking = await this.loadOrFail(bookingId);
    const isCustomer = booking.customerId === requestUserId;
    const isArtisan  = booking.artisanProfile?.user?.id === requestUserId;
    if (!isCustomer && !isArtisan) throw new ForbiddenException('Access denied.');
    return {
      message: 'Booking retrieved.',
      data: plainToInstance(BookingResponseDto, booking, { excludeExtraneousValues: true }),
    };
  }

  async confirm(artisanUserId: number, bookingId: number, dto: RespondBookingDto) {
    const booking = await this.loadOrFail(bookingId, ['artisanProfile', 'artisanProfile.user', 'customer']);
    this.assertArtisanOwner(booking, artisanUserId);
    if (booking.status !== BookingStatus.PENDING) {
      throw new BadRequestException(`Cannot confirm a booking with status ${booking.status}.`);
    }
    booking.status      = BookingStatus.CONFIRMED;
    booking.artisanNotes = dto.artisanNotes;
    await this.repo.save(booking);

    this.eventEmitter.emit(APP_EVENTS.BOOKING_CONFIRMED, {
      customerId:    booking.customerId,
      artisanName:   booking.artisanProfile.businessName ?? `${booking.artisanProfile.user.firstname} ${booking.artisanProfile.user.lastname}`,
      scheduledDate: booking.scheduledDate,
      bookingId:     booking.id,
    } as BookingConfirmedPayload);

    return { message: 'Booking confirmed.' };
  }

  async decline(artisanUserId: number, bookingId: number, dto: RespondBookingDto) {
    const booking = await this.loadOrFail(bookingId, ['artisanProfile', 'artisanProfile.user', 'customer']);
    this.assertArtisanOwner(booking, artisanUserId);
    if (booking.status !== BookingStatus.PENDING) {
      throw new BadRequestException(`Cannot decline a booking with status ${booking.status}.`);
    }
    booking.status       = BookingStatus.DECLINED;
    booking.artisanNotes = dto.artisanNotes;
    await this.repo.save(booking);

    this.eventEmitter.emit(APP_EVENTS.BOOKING_DECLINED, {
      customerId:    booking.customerId,
      artisanName:   booking.artisanProfile.businessName ?? `${booking.artisanProfile.user.firstname} ${booking.artisanProfile.user.lastname}`,
      scheduledDate: booking.scheduledDate,
      bookingId:     booking.id,
    } as BookingDeclinedPayload);

    return { message: 'Booking declined.' };
  }

  async cancel(customerId: number, bookingId: number) {
    const booking = await this.loadOrFail(bookingId, ['artisanProfile', 'artisanProfile.user', 'customer']);
    if (booking.customerId !== customerId) throw new ForbiddenException('Access denied.');
    if (
      booking.status === BookingStatus.COMPLETED ||
      booking.status === BookingStatus.CANCELLED ||
      booking.status === BookingStatus.DECLINED
    ) {
      throw new BadRequestException(`Cannot cancel a booking with status ${booking.status}.`);
    }
    const wasConfirmed = booking.status === BookingStatus.CONFIRMED;
    booking.status = BookingStatus.CANCELLED;
    await this.repo.save(booking);

    if (wasConfirmed) {
      this.eventEmitter.emit(APP_EVENTS.BOOKING_CANCELLED, {
        artisanUserId: booking.artisanProfile.user.id,
        customerName:  `${booking.customer.firstname} ${booking.customer.lastname}`,
        scheduledDate: booking.scheduledDate,
        bookingId:     booking.id,
      } as BookingCancelledPayload);
    }

    return { message: 'Booking cancelled.' };
  }

  async complete(customerId: number, bookingId: number) {
    const booking = await this.loadOrFail(bookingId, ['artisanProfile', 'artisanProfile.user']);
    if (booking.customerId !== customerId) throw new ForbiddenException('Access denied.');
    if (booking.status !== BookingStatus.CONFIRMED) {
      throw new BadRequestException('Only CONFIRMED bookings can be marked as completed.');
    }
    booking.status = BookingStatus.COMPLETED;
    await this.repo.save(booking);

    this.eventEmitter.emit(APP_EVENTS.BOOKING_COMPLETED, {
      artisanUserId: booking.artisanProfile.user.id,
      scheduledDate: booking.scheduledDate,
      bookingId:     booking.id,
    } as BookingCompletedPayload);

    return { message: 'Booking marked as completed.' };
  }

  private async list(
    filter: { customerId?: number; artisanProfileId?: number },
    query: GetBookingsQueryDto,
  ) {
    const page  = query.page  ?? 1;
    const limit = query.limit ?? 20;

    const qb = this.repo
      .createQueryBuilder('b')
      .leftJoinAndSelect('b.customer', 'customer')
      .leftJoinAndSelect('b.artisanProfile', 'artisanProfile')
      .leftJoinAndSelect('artisanProfile.user', 'artisanUser')
      .leftJoinAndSelect('b.availabilitySlot', 'availabilitySlot')
      .orderBy('b.scheduledDate', 'DESC');

    if (filter.customerId)      qb.andWhere('b.customerId = :id',          { id: filter.customerId });
    if (filter.artisanProfileId) qb.andWhere('b.artisanProfileId = :id',   { id: filter.artisanProfileId });
    if (query.status)            qb.andWhere('b.status = :status',          { status: query.status });

    const [records, total] = await qb.skip((page - 1) * limit).take(limit).getManyAndCount();

    return {
      message: 'Bookings retrieved.',
      data:    plainToInstance(BookingResponseDto, records, { excludeExtraneousValues: true }),
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) } as Pagination,
    };
  }

  private async loadOrFail(id: number, relations: string[] = ['customer', 'artisanProfile', 'artisanProfile.user', 'availabilitySlot']): Promise<Booking> {
    const booking = await this.repo.findOne({ where: { id }, relations });
    if (!booking) throw new NotFoundException('Booking not found.');
    return booking;
  }

  private assertArtisanOwner(booking: Booking, artisanUserId: number): void {
    if (booking.artisanProfile?.user?.id !== artisanUserId) {
      throw new ForbiddenException('Access denied.');
    }
  }
}
