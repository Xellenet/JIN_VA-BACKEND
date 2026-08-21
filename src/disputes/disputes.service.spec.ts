import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { DisputesService } from './disputes.service';
import { Dispute } from './entities/dispute.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { Job } from '@jobs/entities/job.entity';
import { Payment } from '../payments/entities/payment.entity';
import { MessagesService } from '@messages/messages.service';
import { DisputeStatus, Role } from '@common/types/enums';
import { APP_EVENTS } from '@common/events/app.events';

/**
 * Covers the two things this round added to disputes: PD4's both-parties
 * outcome notification, and AD2's server-side scope boundary on the
 * dispute-conversation lookup.
 */
describe('DisputesService', () => {
  let service: DisputesService;

  const customerUser = { id: 10, firstname: 'Ama', lastname: 'Mensah' };
  const artisanUser = { id: 20, firstname: 'Yaw', lastname: 'Boateng' };

  const disputeRaisedByCustomer = (status: DisputeStatus) =>
    ({
      id: 5,
      bookingId: 77,
      raisedById: customerUser.id,
      status,
      booking: {
        id: 77,
        customer: customerUser,
        artisanProfile: { user: artisanUser },
      },
      raisedBy: customerUser,
    }) as unknown as Dispute;

  let disputeRepo: { findOne: jest.Mock; save: jest.Mock; create: jest.Mock };
  let emitter: { emit: jest.Mock };
  let messagesService: { getConversationBetween: jest.Mock };

  beforeEach(async () => {
    disputeRepo = {
      findOne: jest.fn(),
      save: jest.fn((d) => Promise.resolve(d)),
      create: jest.fn((d) => d),
    };
    emitter = { emit: jest.fn() };
    messagesService = {
      getConversationBetween: jest
        .fn()
        .mockResolvedValue({ message: 'ok', data: null }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DisputesService,
        { provide: getRepositoryToken(Dispute), useValue: disputeRepo },
        { provide: getRepositoryToken(Booking), useValue: { findOne: jest.fn() } },
        { provide: getRepositoryToken(Job), useValue: { findOne: jest.fn() } },
        { provide: getRepositoryToken(Payment), useValue: { findOne: jest.fn() } },
        { provide: EventEmitter2, useValue: emitter },
        { provide: MessagesService, useValue: messagesService },
      ],
    }).compile();

    service = module.get<DisputesService>(DisputesService);
  });

  describe('resolve / close (PD4)', () => {
    it('notifies both the raiser and the counterparty on resolve', async () => {
      disputeRepo.findOne.mockResolvedValueOnce(
        disputeRaisedByCustomer(DisputeStatus.UNDER_REVIEW),
      );

      await service.resolve(1, 5, { resolution: 'Refund issued in full.' });

      expect(emitter.emit).toHaveBeenCalledWith(
        APP_EVENTS.DISPUTE_RESOLVED,
        expect.objectContaining({
          disputeId: 5,
          bookingId: 77,
          raisedByUserId: customerUser.id,
          counterpartyUserId: artisanUser.id,
          outcome: 'RESOLVED',
          resolution: 'Refund issued in full.',
        }),
      );
    });

    it('notifies both parties on close', async () => {
      disputeRepo.findOne.mockResolvedValueOnce(
        disputeRaisedByCustomer(DisputeStatus.OPEN),
      );

      await service.close(1, 5, {});

      expect(emitter.emit).toHaveBeenCalledWith(
        APP_EVENTS.DISPUTE_CLOSED,
        expect.objectContaining({
          raisedByUserId: customerUser.id,
          counterpartyUserId: artisanUser.id,
          outcome: 'CLOSED',
        }),
      );
    });

    it('resolves the counterparty correctly when the ARTISAN raised the dispute', async () => {
      const raisedByArtisan = {
        ...disputeRaisedByCustomer(DisputeStatus.OPEN),
        raisedById: artisanUser.id,
      } as Dispute;
      disputeRepo.findOne.mockResolvedValueOnce(raisedByArtisan);

      await service.resolve(1, 5, { resolution: 'Work confirmed complete.' });

      expect(emitter.emit).toHaveBeenCalledWith(
        APP_EVENTS.DISPUTE_RESOLVED,
        expect.objectContaining({
          raisedByUserId: artisanUser.id,
          counterpartyUserId: customerUser.id,
        }),
      );
    });

    it('does NOT notify on the interim UNDER_REVIEW transition — only final outcomes notify', async () => {
      disputeRepo.findOne.mockResolvedValueOnce(
        disputeRaisedByCustomer(DisputeStatus.OPEN),
      );

      await service.startReview(1, 5);

      expect(emitter.emit).not.toHaveBeenCalled();
    });
  });

  describe('getConversationForDispute (AD1/AD2)', () => {
    it('allows the lookup while the dispute is OPEN', async () => {
      disputeRepo.findOne.mockResolvedValueOnce(
        disputeRaisedByCustomer(DisputeStatus.OPEN),
      );

      await service.getConversationForDispute(5);

      expect(messagesService.getConversationBetween).toHaveBeenCalledWith(
        customerUser.id,
        artisanUser.id,
        { disputeId: 5, bookingId: 77 },
      );
    });

    it('allows the lookup while the dispute is UNDER_REVIEW', async () => {
      disputeRepo.findOne.mockResolvedValueOnce(
        disputeRaisedByCustomer(DisputeStatus.UNDER_REVIEW),
      );

      await service.getConversationForDispute(5);

      expect(messagesService.getConversationBetween).toHaveBeenCalled();
    });

    it.each([DisputeStatus.RESOLVED, DisputeStatus.CLOSED])(
      'refuses the lookup once the dispute is %s — a settled dispute is not a permanent read tap',
      async (status) => {
        disputeRepo.findOne.mockResolvedValueOnce(
          disputeRaisedByCustomer(status),
        );

        await expect(service.getConversationForDispute(5)).rejects.toThrow(
          ForbiddenException,
        );
        expect(messagesService.getConversationBetween).not.toHaveBeenCalled();
      },
    );

    it('404s on an unknown dispute', async () => {
      disputeRepo.findOne.mockResolvedValueOnce(null);

      await expect(service.getConversationForDispute(404)).rejects.toThrow(
        NotFoundException,
      );
    });

    it("404s when the dispute's booking participants cannot be resolved", async () => {
      disputeRepo.findOne.mockResolvedValueOnce({
        id: 5,
        bookingId: 77,
        raisedById: customerUser.id,
        status: DisputeStatus.OPEN,
        booking: { id: 77, customer: customerUser, artisanProfile: null },
      } as unknown as Dispute);

      await expect(service.getConversationForDispute(5)).rejects.toThrow(
        NotFoundException,
      );
      expect(messagesService.getConversationBetween).not.toHaveBeenCalled();
    });

    it('derives participants from the dispute — it never accepts them from the caller', () => {
      // AD2 as a type-level guarantee: the only public entry point takes a
      // dispute id and nothing else, so there is no parameter an admin could
      // substitute to reach an unrelated conversation.
      expect(service.getConversationForDispute).toHaveLength(1);
    });
  });

  describe('raise (PR3)', () => {
    it('emits DISPUTE_FILED for the admin queue with the raiser labelled by role', async () => {
      const bookingRepo = (
        service as unknown as { bookingRepo: { findOne: jest.Mock } }
      ).bookingRepo;
      bookingRepo.findOne.mockResolvedValueOnce({
        id: 77,
        status: 'COMPLETED',
        customer: customerUser,
        artisanProfile: { user: artisanUser },
      });
      disputeRepo.findOne.mockResolvedValueOnce(null); // no existing dispute
      disputeRepo.save.mockResolvedValueOnce({ id: 5, bookingId: 77 });

      await service.raise(customerUser.id, {
        bookingId: 77,
        reason: 'Work was not completed as agreed.',
      });

      expect(emitter.emit).toHaveBeenCalledWith(
        APP_EVENTS.DISPUTE_FILED,
        expect.objectContaining({
          disputeId: 5,
          bookingId: 77,
          raisedByName: 'Ama Mensah',
          raisedByRole: Role.CUSTOMER,
        }),
      );
    });
  });
});
