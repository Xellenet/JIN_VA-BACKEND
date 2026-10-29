import { BadRequestException, NotFoundException } from '@nestjs/common';
import { In, type Repository } from 'typeorm';
import { AvailabilityStatus, BookingStatus } from '@common/types/enums';
import type { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import type { Booking } from '../bookings/entities/booking.entity';
import type { ArtisanAvailability } from './entities/artisan-availability.entity';
import type { BlockedSlot } from './entities/blocked-slot.entity';
import { AvailabilityService } from './availability.service';

describe('AvailabilityService', () => {
  const profile = () => ({
    id: 30,
    availabilityStatus: AvailabilityStatus.AVAILABLE,
  });

  let overlapQb: { where: jest.Mock; andWhere: jest.Mock; getOne: jest.Mock };
  let slotRepo: Record<string, jest.Mock>;
  let profileRepo: Record<string, jest.Mock>;
  let blockRepo: Record<string, jest.Mock>;
  let bookingRepo: Record<string, jest.Mock>;
  let service: AvailabilityService;

  beforeEach(() => {
    overlapQb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(null),
    };
    slotRepo = {
      createQueryBuilder: jest.fn(() => overlapQb),
      create: jest.fn((v: object) => v),
      save: jest.fn((v: object) => Promise.resolve({ id: 501, ...v })),
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    profileRepo = {
      findOne: jest.fn().mockResolvedValue(profile()),
      save: jest.fn((v: object) => Promise.resolve(v)),
    };
    blockRepo = {
      create: jest.fn((v: object) => v),
      save: jest.fn((v: object) => Promise.resolve({ id: 77, ...v })),
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    bookingRepo = { find: jest.fn().mockResolvedValue([]) };
    service = new AvailabilityService(
      slotRepo as unknown as Repository<ArtisanAvailability>,
      profileRepo as unknown as Repository<ArtisanProfile>,
      blockRepo as unknown as Repository<BlockedSlot>,
      bookingRepo as unknown as Repository<Booking>,
    );
  });

  describe('own schedule', () => {
    it('404s when the caller has no artisan profile', async () => {
      profileRepo.findOne.mockResolvedValue(null);
      await expect(service.getMyAvailability(90)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('returns status and every slot, inactive included', async () => {
      slotRepo.find.mockResolvedValue([
        { id: 1, dayOfWeek: 1, startTime: '09:00', endTime: '12:00' },
      ]);
      const result = await service.getMyAvailability(90);

      expect(profileRepo.findOne).toHaveBeenCalledWith({
        where: { user: { id: 90 } },
      });
      expect(slotRepo.find).toHaveBeenCalledWith({
        where: { artisanProfile: { id: 30 } },
        order: { dayOfWeek: 'ASC', startTime: 'ASC' },
      });
      expect(result.data).toMatchObject({
        artisanProfileId: 30,
        status: AvailabilityStatus.AVAILABLE,
      });
      expect(result.data.slots).toHaveLength(1);
    });

    it('setStatus persists the new status', async () => {
      const result = await service.setStatus(90, {
        status: AvailabilityStatus.BUSY,
      });
      expect(profileRepo.save).toHaveBeenCalledWith({
        id: 30,
        availabilityStatus: AvailabilityStatus.BUSY,
      });
      expect(result.data.status).toBe(AvailabilityStatus.BUSY);
    });
  });

  describe('addSlot', () => {
    const dto = { dayOfWeek: 2, startTime: '09:00', endTime: '13:00' };

    it.each([
      ['equal to', '09:00'],
      ['before', '08:00'],
    ])('rejects an end time %s the start', async (_l, endTime) => {
      await expect(
        service.addSlot(90, { ...dto, endTime } as never),
      ).rejects.toThrow('endTime must be after startTime.');
      expect(slotRepo.save).not.toHaveBeenCalled();
    });

    it('queries for a same-day overlapping window', async () => {
      await service.addSlot(90, dto as never);
      expect(overlapQb.where).toHaveBeenCalledWith(
        'slot.artisanProfileId = :profileId',
        { profileId: 30 },
      );
      expect(overlapQb.andWhere.mock.calls).toEqual([
        ['slot.dayOfWeek = :dayOfWeek', { dayOfWeek: 2 }],
        ['slot.startTime < :endTime', { endTime: '13:00' }],
        ['slot.endTime > :startTime', { startTime: '09:00' }],
      ]);
    });

    it('rejects an overlap and names the existing window', async () => {
      overlapQb.getOne.mockResolvedValue({
        startTime: '12:00:00',
        endTime: '15:00:00',
      });
      const err = await service
        .addSlot(90, dto as never)
        .catch((e: Error) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.message).toContain('(12:00–15:00)');
      expect(slotRepo.save).not.toHaveBeenCalled();
    });

    it('saves a valid slot against the caller profile', async () => {
      const result = await service.addSlot(90, dto as never);
      expect(slotRepo.create).toHaveBeenCalledWith({
        artisanProfile: { id: 30 },
        ...dto,
      });
      expect(result.data).toMatchObject({ id: 501, dayOfWeek: 2 });
    });
  });

  describe('updateSlot', () => {
    const existing = () => ({
      id: 501,
      dayOfWeek: 1,
      startTime: '09:00',
      endTime: '12:00',
      isActive: true,
    });

    it('404s for a slot the caller does not own', async () => {
      slotRepo.findOne.mockResolvedValue(null);
      await expect(service.updateSlot(90, 501, {})).rejects.toThrow(
        'Availability slot 501 not found.',
      );
      expect(slotRepo.findOne).toHaveBeenCalledWith({
        where: { id: 501, artisanProfile: { id: 30 } },
      });
    });

    it('validates the merged times, not just the patch', async () => {
      slotRepo.findOne.mockResolvedValue(existing());
      await expect(
        service.updateSlot(90, 501, { startTime: '12:30' } as never),
      ).rejects.toThrow(BadRequestException);
    });

    it('excludes the slot itself from the overlap check and applies changes', async () => {
      slotRepo.findOne.mockResolvedValue(existing());
      const result = await service.updateSlot(90, 501, {
        dayOfWeek: 4,
        endTime: '11:00',
        isActive: false,
      } as never);

      expect(overlapQb.andWhere).toHaveBeenCalledWith(
        'slot.id != :excludeSlotId',
        { excludeSlotId: 501 },
      );
      expect(overlapQb.andWhere).toHaveBeenCalledWith(
        'slot.dayOfWeek = :dayOfWeek',
        { dayOfWeek: 4 },
      );
      expect(slotRepo.save).toHaveBeenCalledWith({
        id: 501,
        dayOfWeek: 4,
        startTime: '09:00',
        endTime: '11:00',
        isActive: false,
      });
      expect(result.data).toMatchObject({ dayOfWeek: 4, endTime: '11:00' });
    });

    it('keeps isActive when not sent', async () => {
      slotRepo.findOne.mockResolvedValue(existing());
      await service.updateSlot(90, 501, { startTime: '08:00' } as never);
      expect(slotRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ startTime: '08:00', isActive: true }),
      );
    });
  });

  describe('removeSlot', () => {
    it('deletes an owned slot', async () => {
      slotRepo.findOne.mockResolvedValue({ id: 501 });
      await service.removeSlot(90, 501);
      expect(slotRepo.delete).toHaveBeenCalledWith(501);
    });

    it('404s for a slot the caller does not own', async () => {
      slotRepo.findOne.mockResolvedValue(null);
      await expect(service.removeSlot(90, 501)).rejects.toThrow(
        NotFoundException,
      );
      expect(slotRepo.delete).not.toHaveBeenCalled();
    });
  });

  describe('blocked dates (A1)', () => {
    beforeEach(() =>
      jest
        .useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] })
        .setSystemTime(new Date('2026-10-28T10:00:00Z')),
    );
    afterEach(() => jest.useRealTimers());

    it('rejects an end date before the start date', async () => {
      await expect(
        service.addBlock(90, {
          startDate: '2026-11-10',
          endDate: '2026-11-09',
        } as never),
      ).rejects.toThrow('endDate must be on or after startDate.');
    });

    it('rejects a range entirely in the past', async () => {
      await expect(
        service.addBlock(90, {
          startDate: '2026-10-01',
          endDate: '2026-10-27',
        } as never),
      ).rejects.toThrow('Cannot block a date range entirely in the past.');
      expect(blockRepo.save).not.toHaveBeenCalled();
    });

    it('saves a range ending today with no conflicts', async () => {
      const result = await service.addBlock(90, {
        startDate: '2026-10-20',
        endDate: '2026-10-28',
        reason: 'Family event',
      } as never);

      expect(blockRepo.create).toHaveBeenCalledWith({
        artisanProfile: { id: 30 },
        artisanProfileId: 30,
        startDate: '2026-10-20',
        endDate: '2026-10-28',
        reason: 'Family event',
      });
      expect(bookingRepo.find).toHaveBeenCalledWith({
        where: {
          artisanProfile: { id: 30 },
          status: In([BookingStatus.PENDING, BookingStatus.CONFIRMED]),
        },
      });
      expect(result.message).toBe('Blocked date range added.');
      expect(result.data.conflictingBookingIds).toEqual([]);
    });

    it('reports a single booking inside the range without cancelling it', async () => {
      bookingRepo.find.mockResolvedValue([
        { id: 1, scheduledDate: '2026-11-04' },
        { id: 2, scheduledDate: '2026-11-20' },
      ]);
      const result = await service.addBlock(90, {
        startDate: '2026-11-01',
        endDate: '2026-11-07',
      } as never);
      expect(result.data.conflictingBookingIds).toEqual([1]);
      expect(result.message).toBe(
        "Blocked date range added. You still have 1 booking in these dates; decline or cancel it if you can't attend.",
      );
    });

    it('includes bookings on both boundary days and pluralises', async () => {
      bookingRepo.find.mockResolvedValue([
        { id: 3, scheduledDate: '2026-11-01' },
        { id: 4, scheduledDate: '2026-11-07' },
      ]);
      const result = await service.addBlock(90, {
        startDate: '2026-11-01',
        endDate: '2026-11-07',
      } as never);
      expect(result.data.conflictingBookingIds).toEqual([3, 4]);
      expect(result.message).toContain('2 bookings');
      expect(result.message).toContain('cancel them');
    });

    it('lists blocks oldest first', async () => {
      blockRepo.find.mockResolvedValue([
        { id: 77, startDate: '2026-11-01', endDate: '2026-11-07' },
      ]);
      const result = await service.listMyBlocks(90);
      expect(blockRepo.find).toHaveBeenCalledWith({
        where: { artisanProfileId: 30 },
        order: { startDate: 'ASC' },
      });
      expect(result.data).toHaveLength(1);
    });

    it('removes an owned block', async () => {
      blockRepo.findOne.mockResolvedValue({ id: 77 });
      await service.removeBlock(90, 77);
      expect(blockRepo.findOne).toHaveBeenCalledWith({
        where: { id: 77, artisanProfileId: 30 },
      });
      expect(blockRepo.delete).toHaveBeenCalledWith(77);
    });

    it('404s for a block the caller does not own', async () => {
      blockRepo.findOne.mockResolvedValue(null);
      await expect(service.removeBlock(90, 77)).rejects.toThrow(
        'Blocked date range 77 not found.',
      );
      expect(blockRepo.delete).not.toHaveBeenCalled();
    });
  });

  describe('getArtisanAvailability (public)', () => {
    it('404s for an unknown artisan profile', async () => {
      profileRepo.findOne.mockResolvedValue(null);
      await expect(service.getArtisanAvailability(30)).rejects.toThrow(
        'Artisan profile 30 not found.',
      );
    });

    it('shows only active slots and omits bookable windows without a date', async () => {
      const result = await service.getArtisanAvailability(30);
      expect(slotRepo.find).toHaveBeenCalledWith({
        where: { artisanProfile: { id: 30 }, isActive: true },
        order: { dayOfWeek: 'ASC', startTime: 'ASC' },
      });
      expect(result.data.date).toBeUndefined();
      expect(result.data.bookableSlots).toBeUndefined();
    });

    it('adds bookable windows for a requested date', async () => {
      slotRepo.find
        .mockResolvedValueOnce([]) // buildAvailabilityDto
        .mockResolvedValueOnce([{ startTime: '09:00', endTime: '12:00' }]);
      const result = await service.getArtisanAvailability(30, '2026-11-02');
      expect(result.data.date).toBe('2026-11-02');
      expect(result.data.bookableSlots).toEqual([
        { startTime: '09:00', endTime: '12:00' },
      ]);
    });
  });

  describe('computeBookableWindows (R1a)', () => {
    const withDay = (
      slots: Array<{ startTime: string; endTime: string }>,
      occupied: Array<{ startTime: string; endTime: string }> = [],
    ) => {
      slotRepo.find.mockResolvedValue(slots);
      bookingRepo.find.mockResolvedValue(occupied);
    };

    it('returns nothing on a blocked date, without loading slots', async () => {
      blockRepo.find.mockResolvedValue([
        { startDate: '2026-11-01', endDate: '2026-11-03' },
      ]);
      expect(await service.computeBookableWindows(30, '2026-11-03')).toEqual(
        [],
      );
      expect(slotRepo.find).not.toHaveBeenCalled();
    });

    it('ignores blocks that do not cover the date', async () => {
      blockRepo.find.mockResolvedValue([
        { startDate: '2026-11-04', endDate: '2026-11-05' },
      ]);
      withDay([{ startTime: '09:00', endTime: '10:00' }]);
      expect(await service.computeBookableWindows(30, '2026-11-03')).toEqual([
        { startTime: '09:00', endTime: '10:00' },
      ]);
    });

    it('looks up active weekly hours for the UTC weekday of the date', async () => {
      await service.computeBookableWindows(30, '2026-11-01'); // a Sunday
      expect(slotRepo.find).toHaveBeenCalledWith({
        where: { artisanProfileId: 30, dayOfWeek: 0, isActive: true },
        order: { startTime: 'ASC' },
      });
    });

    it('returns nothing, without loading bookings, when no hours that day', async () => {
      expect(await service.computeBookableWindows(30, '2026-11-02')).toEqual(
        [],
      );
      expect(bookingRepo.find).not.toHaveBeenCalled();
    });

    it('only counts pending/confirmed bookings on that date as occupied', async () => {
      withDay([{ startTime: '09:00', endTime: '12:00' }]);
      await service.computeBookableWindows(30, '2026-11-02');
      expect(bookingRepo.find).toHaveBeenCalledWith({
        where: {
          artisanProfile: { id: 30 },
          scheduledDate: '2026-11-02',
          status: In([BookingStatus.PENDING, BookingStatus.CONFIRMED]),
        },
        select: ['startTime', 'endTime'],
      });
    });

    it('splits a window around a booking in the middle', async () => {
      withDay(
        [{ startTime: '09:00', endTime: '12:00' }],
        [{ startTime: '10:00', endTime: '11:00' }],
      );
      expect(await service.computeBookableWindows(30, '2026-11-02')).toEqual([
        { startTime: '09:00', endTime: '10:00' },
        { startTime: '11:00', endTime: '12:00' },
      ]);
    });

    it('handles unsorted, overlapping and edge bookings across several windows', async () => {
      withDay(
        [
          { startTime: '08:00', endTime: '12:00' },
          { startTime: '14:00', endTime: '17:00' },
        ],
        [
          { startTime: '10:00', endTime: '11:00' },
          { startTime: '07:00', endTime: '08:30' },
          { startTime: '10:30', endTime: '10:45' },
          { startTime: '16:00', endTime: '18:00' },
          { startTime: '12:00', endTime: '14:00' },
        ],
      );
      expect(await service.computeBookableWindows(30, '2026-11-02')).toEqual([
        { startTime: '08:30', endTime: '10:00' },
        { startTime: '11:00', endTime: '12:00' },
        { startTime: '14:00', endTime: '16:00' },
      ]);
    });

    it('returns nothing for a fully booked window', async () => {
      withDay(
        [{ startTime: '09:00', endTime: '12:00' }],
        [{ startTime: '09:00', endTime: '12:00' }],
      );
      expect(await service.computeBookableWindows(30, '2026-11-02')).toEqual(
        [],
      );
    });
  });
});
