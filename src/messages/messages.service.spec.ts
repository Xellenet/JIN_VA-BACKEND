import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { MessagesService } from './messages.service';
import { Message } from './entities/message.entity';
import { Conversation } from './entities/conversation.entity';
import { User } from '@users/entities/user.entity';
import { Job } from '@jobs/entities/job.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { Role } from '@common/types/enums';
import { APP_EVENTS } from '@common/events/app.events';

/**
 * Focused on the boundaries this round introduced or is required to preserve:
 * MB1's event emission (the headline bug), MB2's role restriction, MC2's
 * job/booking participation check, MC4's text-or-image rule, and AD1's
 * dispute-scoped lookup.
 */
describe('MessagesService', () => {
  let service: MessagesService;

  const customer = {
    id: 1,
    firstname: 'Ama',
    lastname: 'Mensah',
    role: Role.CUSTOMER,
  } as User;
  const artisan = {
    id: 2,
    firstname: 'Yaw',
    lastname: 'Boateng',
    role: Role.ARTISAN,
  } as User;
  const otherCustomer = {
    id: 3,
    firstname: 'Kofi',
    lastname: 'Owusu',
    role: Role.CUSTOMER,
  } as User;

  let messagesRepo: {
    save: jest.Mock;
    create: jest.Mock;
    findOne: jest.Mock;
    find: jest.Mock;
    findAndCount: jest.Mock;
    count: jest.Mock;
    query: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let conversationsRepo: {
    save: jest.Mock;
    create: jest.Mock;
    findOne: jest.Mock;
    update: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let usersRepo: { findOne: jest.Mock };
  let jobsRepo: { findOne: jest.Mock };
  let bookingsRepo: { findOne: jest.Mock };
  let emitter: { emit: jest.Mock };

  beforeEach(async () => {
    messagesRepo = {
      save: jest.fn((m) => Promise.resolve({ id: 99, ...m })),
      create: jest.fn((m) => m),
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      findAndCount: jest.fn().mockResolvedValue([[], 0]),
      count: jest.fn().mockResolvedValue(0),
      query: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(),
    };
    conversationsRepo = {
      save: jest.fn((c) => Promise.resolve({ id: 7, ...c })),
      create: jest.fn((c) => c),
      findOne: jest.fn(),
      update: jest.fn(),
      createQueryBuilder: jest.fn(),
    };
    usersRepo = { findOne: jest.fn() };
    jobsRepo = { findOne: jest.fn() };
    bookingsRepo = { findOne: jest.fn() };
    emitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessagesService,
        { provide: getRepositoryToken(Message), useValue: messagesRepo },
        {
          provide: getRepositoryToken(Conversation),
          useValue: conversationsRepo,
        },
        { provide: getRepositoryToken(User), useValue: usersRepo },
        { provide: getRepositoryToken(Job), useValue: jobsRepo },
        { provide: getRepositoryToken(Booking), useValue: bookingsRepo },
        { provide: EventEmitter2, useValue: emitter },
      ],
    }).compile();

    service = module.get<MessagesService>(MessagesService);
  });

  /** Wires up the two-user lookup `send` does in a single Promise.all. */
  const mockUsers = (sender: User, recipient: User | null) => {
    usersRepo.findOne
      .mockResolvedValueOnce(sender)
      .mockResolvedValueOnce(recipient);
  };

  describe('send (MB1/MB2)', () => {
    it('emits MESSAGE_RECEIVED so the recipient is actually notified — the headline bug this feature fixes', async () => {
      mockUsers(customer, artisan);
      conversationsRepo.findOne.mockResolvedValueOnce(null);
      messagesRepo.findOne.mockResolvedValueOnce({
        id: 99,
        content: 'Hello',
        sender: customer,
      });

      await service.send(customer.id, {
        recipientId: artisan.id,
        content: 'Hello',
      });

      expect(emitter.emit).toHaveBeenCalledWith(
        APP_EVENTS.MESSAGE_RECEIVED,
        expect.objectContaining({
          recipientId: artisan.id,
          senderName: 'Ama Mensah',
          preview: 'Hello',
          conversationId: 7,
        }),
      );
    });

    it('rejects same-role messaging (customer to customer) — the gap the retired module left open', async () => {
      mockUsers(customer, otherCustomer);

      await expect(
        service.send(customer.id, {
          recipientId: otherCustomer.id,
          content: 'Hi',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(messagesRepo.save).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('rejects messaging yourself', async () => {
      await expect(
        service.send(customer.id, {
          recipientId: customer.id,
          content: 'Hi',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('404s on an unknown recipient', async () => {
      mockUsers(customer, null);

      await expect(
        service.send(customer.id, { recipientId: 4242, content: 'Hi' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('appends to the existing conversation rather than creating a second one', async () => {
      mockUsers(artisan, customer);
      conversationsRepo.findOne.mockResolvedValueOnce({ id: 7 });
      messagesRepo.findOne.mockResolvedValueOnce({ id: 100, sender: artisan });

      await service.send(artisan.id, {
        recipientId: customer.id,
        content: 'Reply',
      });

      expect(conversationsRepo.save).not.toHaveBeenCalled();
      expect(conversationsRepo.update).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ lastMessageAt: expect.any(Date) }),
      );
    });
  });

  describe('send — MC4 attachments', () => {
    it('accepts an image with no text and derives the MIME type from the URL', async () => {
      mockUsers(customer, artisan);
      conversationsRepo.findOne.mockResolvedValueOnce({ id: 7 });
      messagesRepo.findOne.mockResolvedValueOnce({ id: 101, sender: customer });

      await service.send(customer.id, {
        recipientId: artisan.id,
        attachmentUrl: '/uploads/messages/pipe.png',
      });

      expect(messagesRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          content: null,
          attachmentUrl: '/uploads/messages/pipe.png',
          attachmentType: 'image/png',
        }),
      );
    });

    it('previews an image-only message as "Sent a photo" rather than an empty notification body', async () => {
      mockUsers(customer, artisan);
      conversationsRepo.findOne.mockResolvedValueOnce({ id: 7 });
      messagesRepo.findOne.mockResolvedValueOnce({ id: 102, sender: customer });

      await service.send(customer.id, {
        recipientId: artisan.id,
        attachmentUrl: '/uploads/messages/pipe.jpg',
      });

      expect(emitter.emit).toHaveBeenCalledWith(
        APP_EVENTS.MESSAGE_RECEIVED,
        expect.objectContaining({ preview: 'Sent a photo' }),
      );
    });

    it('rejects a message with neither text nor an image', async () => {
      await expect(
        service.send(customer.id, { recipientId: artisan.id }),
      ).rejects.toThrow(BadRequestException);
      expect(usersRepo.findOne).not.toHaveBeenCalled();
    });

    it('treats whitespace-only text as no text', async () => {
      await expect(
        service.send(customer.id, {
          recipientId: artisan.id,
          content: '   ',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('send — MC2 job/booking context', () => {
    it('rejects a jobId the sender is not a participant of', async () => {
      mockUsers(customer, artisan);
      jobsRepo.findOne.mockResolvedValueOnce({
        id: 55,
        customer: otherCustomer,
        acceptedArtisan: artisan,
      });

      await expect(
        service.send(customer.id, {
          recipientId: artisan.id,
          content: 'About job 55',
          jobId: 55,
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(messagesRepo.save).not.toHaveBeenCalled();
    });

    it('persists a jobId the sender IS a participant of', async () => {
      mockUsers(customer, artisan);
      jobsRepo.findOne.mockResolvedValueOnce({
        id: 55,
        customer,
        acceptedArtisan: artisan,
      });
      conversationsRepo.findOne.mockResolvedValueOnce({ id: 7 });
      messagesRepo.findOne.mockResolvedValueOnce({ id: 103, sender: customer });

      await service.send(customer.id, {
        recipientId: artisan.id,
        content: 'About job 55',
        jobId: 55,
      });

      expect(messagesRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: 55, bookingId: null }),
      );
    });

    it('rejects a bookingId the sender is not a participant of', async () => {
      mockUsers(customer, artisan);
      bookingsRepo.findOne.mockResolvedValueOnce({
        id: 88,
        customer: otherCustomer,
        artisanProfile: { user: artisan },
      });

      await expect(
        service.send(customer.id, {
          recipientId: artisan.id,
          content: 'About booking 88',
          bookingId: 88,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejects jobId and bookingId together', async () => {
      await expect(
        service.send(customer.id, {
          recipientId: artisan.id,
          content: 'Both?',
          jobId: 1,
          bookingId: 2,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('sends a general inquiry with no job/booking reference — must keep working exactly as before', async () => {
      mockUsers(customer, artisan);
      conversationsRepo.findOne.mockResolvedValueOnce({ id: 7 });
      messagesRepo.findOne.mockResolvedValueOnce({ id: 104, sender: customer });

      await service.send(customer.id, {
        recipientId: artisan.id,
        content: 'Are you free next week?',
      });

      expect(jobsRepo.findOne).not.toHaveBeenCalled();
      expect(bookingsRepo.findOne).not.toHaveBeenCalled();
      expect(messagesRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: null, bookingId: null }),
      );
    });
  });

  describe('thread access (permission boundary)', () => {
    it('forbids a non-participant from reading a conversation', async () => {
      conversationsRepo.findOne.mockResolvedValueOnce({
        id: 7,
        participantA: customer,
        participantB: artisan,
      });

      await expect(
        service.getMessages(otherCustomer.id, 7, {}),
      ).rejects.toThrow(ForbiddenException);
    });

    it('forbids a non-participant from marking a conversation read', async () => {
      conversationsRepo.findOne.mockResolvedValueOnce({
        id: 7,
        participantA: customer,
        participantB: artisan,
      });

      await expect(service.markRead(otherCustomer.id, 7)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('404s on an unknown conversation', async () => {
      conversationsRepo.findOne.mockResolvedValueOnce(null);

      await expect(service.getMessages(customer.id, 404, {})).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('getConversationBetween (AD1)', () => {
    it('returns data: null with a clear message when the two parties never messaged', async () => {
      conversationsRepo.findOne.mockResolvedValueOnce(null);

      const result = await service.getConversationBetween(
        customer.id,
        artisan.id,
        { disputeId: 12, bookingId: 34 },
      );

      expect(result.data).toBeNull();
      expect(result.message).toContain('No conversation on file');
    });

    it('labels each side by role so the admin view can tag bubbles, and marks the payload read-only', async () => {
      conversationsRepo.findOne.mockResolvedValueOnce({
        id: 7,
        participantA: customer,
        participantB: artisan,
      });
      messagesRepo.count.mockResolvedValueOnce(2);
      messagesRepo.find.mockResolvedValueOnce([
        { id: 2, content: 'second', sender: artisan },
        { id: 1, content: 'first', sender: customer },
      ]);

      const result = await service.getConversationBetween(
        customer.id,
        artisan.id,
        { disputeId: 12, bookingId: 34 },
      );

      expect(result.data).not.toBeNull();
      expect(result.data!.customer.id).toBe(customer.id);
      expect(result.data!.customer.role).toBe(Role.CUSTOMER);
      expect(result.data!.artisan.id).toBe(artisan.id);
      expect(result.data!.artisan.role).toBe(Role.ARTISAN);
      expect(result.data!.readOnly).toBe(true);
      expect(result.data!.disputeId).toBe(12);
      expect(result.data!.bookingId).toBe(34);
      expect(result.data!.totalMessages).toBe(2);
      // Fetched newest-first for the cap, then flipped so the admin reads the
      // thread in conversation order.
      expect(result.data!.messages.map((m) => m.id)).toEqual([1, 2]);
    });
  });
});
