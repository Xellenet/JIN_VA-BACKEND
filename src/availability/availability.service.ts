import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { plainToInstance } from 'class-transformer';
import { In, Repository } from 'typeorm';
import { ArtisanAvailability } from './entities/artisan-availability.entity';
import { BlockedSlot } from './entities/blocked-slot.entity';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { SetAvailabilityStatusDto } from './dto/set-availability-status.dto';
import { CreateAvailabilitySlotDto } from './dto/create-availability-slot.dto';
import { UpdateAvailabilitySlotDto } from './dto/update-availability-slot.dto';
import { CreateBlockedSlotDto } from './dto/create-blocked-slot.dto';
import {
  ArtisanAvailabilityResponseDto,
  AvailabilitySlotResponseDto,
  BlockedSlotResponseDto,
  BookableWindowDto,
} from './dto/availability-response.dto';
import { SUCCESS_MESSAGES } from '@common/constants/success-messages.constants';
import { BookingStatus } from '@common/types/enums';

type SlotItem = { message: string; data: AvailabilitySlotResponseDto };
type AvailabilityItem = {
  message: string;
  data: ArtisanAvailabilityResponseDto;
};
type BlockItem = { message: string; data: BlockedSlotResponseDto };
type BlockList = { message: string; data: BlockedSlotResponseDto[] };

/** Bookings in these statuses occupy a slot for concurrency/availability purposes (A4/R1a). */
const OCCUPYING_BOOKING_STATUSES = [
  BookingStatus.PENDING,
  BookingStatus.CONFIRMED,
];

@Injectable()
export class AvailabilityService {
  private readonly logger = new Logger(AvailabilityService.name);

  constructor(
    @InjectRepository(ArtisanAvailability)
    private readonly slotRepo: Repository<ArtisanAvailability>,
    @InjectRepository(ArtisanProfile)
    private readonly profileRepo: Repository<ArtisanProfile>,
    @InjectRepository(BlockedSlot)
    private readonly blockRepo: Repository<BlockedSlot>,
    @InjectRepository(Booking)
    private readonly bookingRepo: Repository<Booking>,
  ) {}

  // ─── Artisan self-management ─────────────────────────────────────────────────

  async getMyAvailability(userId: number): Promise<AvailabilityItem> {
    const profile = await this.loadProfileOrFail(userId);
    return {
      message: SUCCESS_MESSAGES.AVAILABILITY.RETRIEVED,
      data: await this.buildAvailabilityDto(profile, false),
    };
  }

  async setStatus(
    userId: number,
    dto: SetAvailabilityStatusDto,
  ): Promise<AvailabilityItem> {
    const profile = await this.loadProfileOrFail(userId);
    profile.availabilityStatus = dto.status;
    await this.profileRepo.save(profile);
    this.logger.log(`Artisan profile ${profile.id} status → ${dto.status}`);
    return {
      message: SUCCESS_MESSAGES.AVAILABILITY.STATUS_UPDATED,
      data: await this.buildAvailabilityDto(profile, false),
    };
  }

  async addSlot(
    userId: number,
    dto: CreateAvailabilitySlotDto,
  ): Promise<SlotItem> {
    const profile = await this.loadProfileOrFail(userId);
    this.assertValidTimes(dto.startTime, dto.endTime);
    await this.assertNoOverlap(
      profile.id,
      dto.dayOfWeek,
      dto.startTime,
      dto.endTime,
    );

    const slot = await this.slotRepo.save(
      this.slotRepo.create({
        artisanProfile: { id: profile.id },
        dayOfWeek: dto.dayOfWeek,
        startTime: dto.startTime,
        endTime: dto.endTime,
      }),
    );

    this.logger.log(
      `Artisan ${profile.id} added slot: day ${dto.dayOfWeek} ${dto.startTime}–${dto.endTime}`,
    );
    return {
      message: SUCCESS_MESSAGES.AVAILABILITY.SLOT_ADDED,
      data: plainToInstance(AvailabilitySlotResponseDto, slot, {
        excludeExtraneousValues: true,
      }),
    };
  }

  async updateSlot(
    userId: number,
    slotId: number,
    dto: UpdateAvailabilitySlotDto,
  ): Promise<SlotItem> {
    const profile = await this.loadProfileOrFail(userId);
    const slot = await this.loadSlotOrFail(slotId, profile.id);

    const nextDay = dto.dayOfWeek ?? slot.dayOfWeek;
    const nextStart = dto.startTime ?? slot.startTime;
    const nextEnd = dto.endTime ?? slot.endTime;

    this.assertValidTimes(nextStart, nextEnd);
    await this.assertNoOverlap(profile.id, nextDay, nextStart, nextEnd, slotId);

    slot.dayOfWeek = nextDay;
    slot.startTime = nextStart;
    slot.endTime = nextEnd;
    if (dto.isActive !== undefined) slot.isActive = dto.isActive;

    await this.slotRepo.save(slot);
    return {
      message: SUCCESS_MESSAGES.AVAILABILITY.SLOT_UPDATED,
      data: plainToInstance(AvailabilitySlotResponseDto, slot, {
        excludeExtraneousValues: true,
      }),
    };
  }

  async removeSlot(
    userId: number,
    slotId: number,
  ): Promise<{ message: string }> {
    const profile = await this.loadProfileOrFail(userId);
    await this.loadSlotOrFail(slotId, profile.id);
    await this.slotRepo.delete(slotId);
    return { message: SUCCESS_MESSAGES.AVAILABILITY.SLOT_REMOVED };
  }

  // ─── A1: blocked dates / time-off (ownership-scoped, mirrors slot pattern) ───

  async addBlock(
    userId: number,
    dto: CreateBlockedSlotDto,
  ): Promise<BlockItem> {
    const profile = await this.loadProfileOrFail(userId);
    this.assertValidBlockRange(dto.startDate, dto.endDate);

    const block = await this.blockRepo.save(
      this.blockRepo.create({
        artisanProfile: { id: profile.id },
        artisanProfileId: profile.id,
        startDate: dto.startDate,
        endDate: dto.endDate,
        reason: dto.reason,
      }),
    );

    // A1 edge case: a block never implicitly cancels/declines an existing
    // PENDING/CONFIRMED booking that falls inside it — we surface which
    // bookings now conflict so the artisan can decide (decline/cancel) via
    // the existing endpoints, rather than silently orphaning them.
    const conflicting = await this.bookingRepo.find({
      where: {
        artisanProfileId: profile.id,
        status: In(OCCUPYING_BOOKING_STATUSES),
      },
    });
    const overlapping = conflicting.filter(
      (b) => b.scheduledDate >= dto.startDate && b.scheduledDate <= dto.endDate,
    );
    if (overlapping.length > 0) {
      this.logger.warn(
        `Block ${block.id} on artisan ${profile.id} overlaps ${overlapping.length} ` +
          `existing booking(s): [${overlapping.map((b) => b.id).join(', ')}]. ` +
          'These are not auto-cancelled — the artisan must decline/cancel them explicitly.',
      );
    }

    this.logger.log(
      `Artisan ${profile.id} added block ${block.id}: ${dto.startDate}–${dto.endDate}`,
    );
    return {
      message: 'Blocked date range added.',
      data: this.toBlockDto(block),
    };
  }

  async listMyBlocks(userId: number): Promise<BlockList> {
    const profile = await this.loadProfileOrFail(userId);
    const blocks = await this.blockRepo.find({
      where: { artisanProfileId: profile.id },
      order: { startDate: 'ASC' },
    });
    return {
      message: 'Blocked date ranges retrieved.',
      data: blocks.map((b) => this.toBlockDto(b)),
    };
  }

  async removeBlock(
    userId: number,
    blockId: number,
  ): Promise<{ message: string }> {
    const profile = await this.loadProfileOrFail(userId);
    const block = await this.blockRepo.findOne({
      where: { id: blockId, artisanProfileId: profile.id },
    });
    // Ownership folded into the lookup: another artisan's block and a
    // non-existent one are both indistinguishable 404s to the caller.
    if (!block) {
      throw new NotFoundException(`Blocked date range ${blockId} not found.`);
    }
    await this.blockRepo.delete(block.id);
    return { message: 'Blocked date range removed.' };
  }

  // ─── Public read ─────────────────────────────────────────────────────────────

  /**
   * R1a: when `date` is supplied, additionally computes the artisan's
   * actually-bookable windows for that date (weekly hours minus A1 blocks
   * minus PENDING/CONFIRMED bookings) using the exact same exclusion set as
   * A4's write-path lock, so the picker and the atomic lock never disagree.
   */
  async getArtisanAvailability(
    artisanProfileId: number,
    date?: string,
  ): Promise<AvailabilityItem> {
    const profile = await this.profileRepo.findOne({
      where: { id: artisanProfileId },
    });
    if (!profile)
      throw new NotFoundException(
        `Artisan profile ${artisanProfileId} not found.`,
      );

    const data = await this.buildAvailabilityDto(profile, true);

    if (date) {
      data.date = date;
      data.bookableSlots = await this.computeBookableWindows(
        artisanProfileId,
        date,
      );
    }

    return {
      message: SUCCESS_MESSAGES.AVAILABILITY.RETRIEVED,
      data,
    };
  }

  /**
   * Computes the actually-bookable windows for one artisan/date. Exposed for
   * reuse by `BookingsService.create()` (A4) so the write-path lock validates
   * against the identical exclusion set as this read path.
   */
  async computeBookableWindows(
    artisanProfileId: number,
    date: string,
  ): Promise<BookableWindowDto[]> {
    // A1: an active block covering this date wipes out the entire day,
    // independent of whether weekly hours are configured (edge case: both
    // mechanisms are independent, neither gates the other). Range overlap
    // is checked in-memory since it's two independent bounds per row.
    const blocks = await this.blockRepo.find({ where: { artisanProfileId } });
    const isBlocked = blocks.some(
      (b) => date >= b.startDate && date <= b.endDate,
    );
    if (isBlocked) return [];

    // Day-of-week computed from the UTC calendar date (NFR (c)) — 0 = Sunday.
    const dayOfWeek = new Date(`${date}T00:00:00.000Z`).getUTCDay();

    const weeklySlots = await this.slotRepo.find({
      where: { artisanProfileId, dayOfWeek, isActive: true },
      order: { startTime: 'ASC' },
    });
    if (weeklySlots.length === 0) return [];

    const occupied = await this.bookingRepo.find({
      where: {
        // Booking.artisanProfileId is a @RelationId (virtual, not a real
        // column, unlike ArtisanAvailability/BlockedSlot's plain @Column) —
        // it can't be used in a where clause directly; filter via the
        // relation object instead.
        artisanProfile: { id: artisanProfileId },
        scheduledDate: date,
        status: In(OCCUPYING_BOOKING_STATUSES),
      },
      select: ['startTime', 'endTime'],
    });

    const result: BookableWindowDto[] = [];
    for (const slot of weeklySlots) {
      result.push(
        ...this.subtractOccupied(slot.startTime, slot.endTime, occupied),
      );
    }
    return result;
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Fragments one [start, end) window by subtracting every overlapping
   * occupied interval, returning the remaining open sub-windows in order.
   * (e.g. 09:00–12:00 minus 10:00–11:00 → [09:00–10:00, 11:00–12:00]).
   */
  private subtractOccupied(
    windowStart: string,
    windowEnd: string,
    occupied: { startTime: string; endTime: string }[],
  ): BookableWindowDto[] {
    const overlapping = occupied
      .filter((o) => o.endTime > windowStart && o.startTime < windowEnd)
      .sort((a, b) => a.startTime.localeCompare(b.startTime));

    const result: BookableWindowDto[] = [];
    let cursor = windowStart;
    for (const o of overlapping) {
      const gapStart = o.startTime > cursor ? o.startTime : cursor;
      if (gapStart > cursor) {
        result.push({ startTime: cursor, endTime: gapStart });
      }
      if (o.endTime > cursor) cursor = o.endTime;
    }
    if (cursor < windowEnd) {
      result.push({ startTime: cursor, endTime: windowEnd });
    }
    return result;
  }

  private async buildAvailabilityDto(
    profile: ArtisanProfile,
    activeOnly: boolean,
  ): Promise<ArtisanAvailabilityResponseDto> {
    const slots = await this.slotRepo.find({
      where: {
        artisanProfile: { id: profile.id },
        ...(activeOnly && { isActive: true }),
      },
      order: { dayOfWeek: 'ASC', startTime: 'ASC' },
    });

    return {
      artisanProfileId: profile.id,
      status: profile.availabilityStatus,
      slots: plainToInstance(AvailabilitySlotResponseDto, slots, {
        excludeExtraneousValues: true,
      }),
    };
  }

  private toBlockDto(block: BlockedSlot): BlockedSlotResponseDto {
    return plainToInstance(BlockedSlotResponseDto, block, {
      excludeExtraneousValues: true,
    });
  }

  private async loadProfileOrFail(userId: number): Promise<ArtisanProfile> {
    const profile = await this.profileRepo.findOne({
      where: { user: { id: userId } },
    });
    if (!profile)
      throw new NotFoundException(
        'Artisan profile not found. Set up your profile first.',
      );
    return profile;
  }

  private async loadSlotOrFail(
    slotId: number,
    profileId: number,
  ): Promise<ArtisanAvailability> {
    const slot = await this.slotRepo.findOne({
      where: { id: slotId, artisanProfile: { id: profileId } },
    });
    // Ownership check is implicit: the slot must belong to the caller's profile
    if (!slot)
      throw new NotFoundException(`Availability slot ${slotId} not found.`);
    return slot;
  }

  private assertValidTimes(startTime: string, endTime: string): void {
    if (endTime <= startTime) {
      throw new BadRequestException('endTime must be after startTime.');
    }
  }

  private assertValidBlockRange(startDate: string, endDate: string): void {
    if (endDate < startDate) {
      throw new BadRequestException('endDate must be on or after startDate.');
    }
    const today = new Date().toISOString().slice(0, 10);
    if (endDate < today) {
      throw new BadRequestException(
        'Cannot block a date range entirely in the past.',
      );
    }
  }

  private async assertNoOverlap(
    profileId: number,
    dayOfWeek: number,
    startTime: string,
    endTime: string,
    excludeSlotId?: number,
  ): Promise<void> {
    const qb = this.slotRepo
      .createQueryBuilder('slot')
      .where('slot.artisanProfileId = :profileId', { profileId })
      .andWhere('slot.dayOfWeek = :dayOfWeek', { dayOfWeek })
      // Overlap condition: existing slot starts before new ends AND existing slot ends after new starts
      .andWhere('slot.startTime < :endTime', { endTime })
      .andWhere('slot.endTime > :startTime', { startTime });

    if (excludeSlotId !== undefined) {
      qb.andWhere('slot.id != :excludeSlotId', { excludeSlotId });
    }

    const overlapping = await qb.getOne();
    if (overlapping) {
      throw new BadRequestException(
        `This slot overlaps with an existing slot (${overlapping.startTime}–${overlapping.endTime}) on the same day.`,
      );
    }
  }
}
