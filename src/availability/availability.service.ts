import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { plainToInstance } from 'class-transformer';
import { Repository } from 'typeorm';
import { ArtisanAvailability } from './entities/artisan-availability.entity';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { SetAvailabilityStatusDto } from './dto/set-availability-status.dto';
import { CreateAvailabilitySlotDto } from './dto/create-availability-slot.dto';
import { UpdateAvailabilitySlotDto } from './dto/update-availability-slot.dto';
import {
  ArtisanAvailabilityResponseDto,
  AvailabilitySlotResponseDto,
} from './dto/availability-response.dto';
import { SUCCESS_MESSAGES } from '@common/constants/success-messages.constants';

type SlotItem         = { message: string; data: AvailabilitySlotResponseDto };
type AvailabilityItem = { message: string; data: ArtisanAvailabilityResponseDto };

@Injectable()
export class AvailabilityService {
  private readonly logger = new Logger(AvailabilityService.name);

  constructor(
    @InjectRepository(ArtisanAvailability)
    private readonly slotRepo: Repository<ArtisanAvailability>,
    @InjectRepository(ArtisanProfile)
    private readonly profileRepo: Repository<ArtisanProfile>,
  ) {}

  // ─── Artisan self-management ─────────────────────────────────────────────────

  async getMyAvailability(userId: number): Promise<AvailabilityItem> {
    const profile = await this.loadProfileOrFail(userId);
    return {
      message: SUCCESS_MESSAGES.AVAILABILITY.RETRIEVED,
      data:    await this.buildAvailabilityDto(profile, false),
    };
  }

  async setStatus(userId: number, dto: SetAvailabilityStatusDto): Promise<AvailabilityItem> {
    const profile = await this.loadProfileOrFail(userId);
    profile.availabilityStatus = dto.status;
    await this.profileRepo.save(profile);
    this.logger.log(`Artisan profile ${profile.id} status → ${dto.status}`);
    return {
      message: SUCCESS_MESSAGES.AVAILABILITY.STATUS_UPDATED,
      data:    await this.buildAvailabilityDto(profile, false),
    };
  }

  async addSlot(userId: number, dto: CreateAvailabilitySlotDto): Promise<SlotItem> {
    const profile = await this.loadProfileOrFail(userId);
    this.assertValidTimes(dto.startTime, dto.endTime);
    await this.assertNoOverlap(profile.id, dto.dayOfWeek, dto.startTime, dto.endTime);

    const slot = await this.slotRepo.save(
      this.slotRepo.create({
        artisanProfile: { id: profile.id },
        dayOfWeek:      dto.dayOfWeek,
        startTime:      dto.startTime,
        endTime:        dto.endTime,
      }),
    );

    this.logger.log(`Artisan ${profile.id} added slot: day ${dto.dayOfWeek} ${dto.startTime}–${dto.endTime}`);
    return {
      message: SUCCESS_MESSAGES.AVAILABILITY.SLOT_ADDED,
      data:    plainToInstance(AvailabilitySlotResponseDto, slot, { excludeExtraneousValues: true }),
    };
  }

  async updateSlot(
    userId: number,
    slotId: number,
    dto: UpdateAvailabilitySlotDto,
  ): Promise<SlotItem> {
    const profile = await this.loadProfileOrFail(userId);
    const slot    = await this.loadSlotOrFail(slotId, profile.id);

    const nextDay   = dto.dayOfWeek  ?? slot.dayOfWeek;
    const nextStart = dto.startTime  ?? slot.startTime;
    const nextEnd   = dto.endTime    ?? slot.endTime;

    this.assertValidTimes(nextStart, nextEnd);
    await this.assertNoOverlap(profile.id, nextDay, nextStart, nextEnd, slotId);

    slot.dayOfWeek  = nextDay;
    slot.startTime  = nextStart;
    slot.endTime    = nextEnd;
    if (dto.isActive !== undefined) slot.isActive = dto.isActive;

    await this.slotRepo.save(slot);
    return {
      message: SUCCESS_MESSAGES.AVAILABILITY.SLOT_UPDATED,
      data:    plainToInstance(AvailabilitySlotResponseDto, slot, { excludeExtraneousValues: true }),
    };
  }

  async removeSlot(userId: number, slotId: number): Promise<{ message: string }> {
    const profile = await this.loadProfileOrFail(userId);
    await this.loadSlotOrFail(slotId, profile.id);
    await this.slotRepo.delete(slotId);
    return { message: SUCCESS_MESSAGES.AVAILABILITY.SLOT_REMOVED };
  }

  // ─── Public read ─────────────────────────────────────────────────────────────

  async getArtisanAvailability(artisanProfileId: number): Promise<AvailabilityItem> {
    const profile = await this.profileRepo.findOne({ where: { id: artisanProfileId } });
    if (!profile) throw new NotFoundException(`Artisan profile ${artisanProfileId} not found.`);
    return {
      message: SUCCESS_MESSAGES.AVAILABILITY.RETRIEVED,
      data:    await this.buildAvailabilityDto(profile, true),
    };
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

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
      status:           profile.availabilityStatus,
      slots:            plainToInstance(AvailabilitySlotResponseDto, slots, {
        excludeExtraneousValues: true,
      }),
    };
  }

  private async loadProfileOrFail(userId: number): Promise<ArtisanProfile> {
    const profile = await this.profileRepo.findOne({
      where: { user: { id: userId } },
    });
    if (!profile) throw new NotFoundException('Artisan profile not found. Set up your profile first.');
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
    if (!slot) throw new NotFoundException(`Availability slot ${slotId} not found.`);
    return slot;
  }

  private assertValidTimes(startTime: string, endTime: string): void {
    if (endTime <= startTime) {
      throw new BadRequestException('endTime must be after startTime.');
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
