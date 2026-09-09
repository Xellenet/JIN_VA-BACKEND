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

  /** A filename in the shape `POST /uploads/message-attachment` actually mints. */
  const UUID = '3f1e6c1a-1c2b-4d8e-9a7f-0b1c2d3e4f56';

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

  /**
   * The subset of a persisted message these tests assert on. Declared so the
   * mocks are typed rather than `any` — `create.mock.calls` is how we read back
   * what the service tried to persist.
   */
  type MessageRow = {
    conversation: { id: number };
    sender: { id: number };
    content: string | null;
    attachmentUrl: string | null;
    attachmentType: string | null;
    jobId: number | null;
    bookingId: number | null;
  };
  type ConversationRow = { id?: number };

  let messagesRepo: {
    save: jest.Mock<Promise<MessageRow & { id: number }>, [MessageRow]>;
    create: jest.Mock<MessageRow, [MessageRow]>;
    findOne: jest.Mock;
    find: jest.Mock;
    findAndCount: jest.Mock;
    count: jest.Mock;
    query: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let conversationsRepo: {
    save: jest.Mock<
      Promise<ConversationRow & { id: number }>,
      [ConversationRow]
    >;
    create: jest.Mock<ConversationRow, [ConversationRow]>;
    findOne: jest.Mock;
    update: jest.Mock<Promise<unknown>, [number, { lastMessageAt: Date }]>;
    createQueryBuilder: jest.Mock;
  };
  let usersRepo: { findOne: jest.Mock };
  let jobsRepo: { findOne: jest.Mock };
  let bookingsRepo: { findOne: jest.Mock };
  let emitter: { emit: jest.Mock };

  beforeEach(async () => {
    messagesRepo = {
      save: jest.fn((m: MessageRow) => Promise.resolve({ ...m, id: 99 })),
      create: jest.fn((m: MessageRow) => m),
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      findAndCount: jest.fn().mockResolvedValue([[], 0]),
      count: jest.fn().mockResolvedValue(0),
      query: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(),
    };
    conversationsRepo = {
      save: jest.fn((c: ConversationRow) => Promise.resolve({ ...c, id: 7 })),
      create: jest.fn((c: ConversationRow) => c),
      findOne: jest.fn(),
      // Typed implementation (rather than a bare jest.fn()) so
      // `update.mock.calls[0]` reads back as a real tuple instead of `any`.
      update: jest.fn((_id: number, _patch: { lastMessageAt: Date }) =>
        Promise.resolve<unknown>(undefined),
      ),
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
      expect(conversationsRepo.update).toHaveBeenCalledTimes(1);
      const [conversationId, patch] = conversationsRepo.update.mock.calls[0];
      expect(conversationId).toBe(7);
      expect(patch.lastMessageAt).toBeInstanceOf(Date);
    });
  });

  describe('send — MC4 attachments', () => {
    it('accepts an image with no text and derives the MIME type from the URL', async () => {
      mockUsers(customer, artisan);
      conversationsRepo.findOne.mockResolvedValueOnce({ id: 7 });
      messagesRepo.findOne.mockResolvedValueOnce({ id: 101, sender: customer });

      const url = `/uploads/messages/${UUID}.png`;
      await service.send(customer.id, {
        recipientId: artisan.id,
        attachmentUrl: url,
      });

      expect(messagesRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          content: null,
          attachmentUrl: url,
          attachmentType: 'image/png',
        }),
      );
    });

    /**
     * QA B2: `attachmentType` used to default to `image/jpeg` for any
     * unrecognised extension, so a `.pdf`/`.svg` reference was announced to
     * clients — and to the admin dispute viewer — as a JPEG. The DTO's
     * `@IsAttachmentUrl('messages')` now rejects those before the service is
     * reached; this asserts the service does not lie if one ever gets past it.
     */
    it('refuses an extension it cannot honestly name rather than defaulting to image/jpeg', async () => {
      mockUsers(customer, artisan);
      conversationsRepo.findOne.mockResolvedValueOnce({ id: 7 });

      await expect(
        service.send(customer.id, {
          recipientId: artisan.id,
          attachmentUrl: `/uploads/messages/${UUID}.svg`,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(messagesRepo.save).not.toHaveBeenCalled();
    });

    it('previews an image-only message as "Sent a photo" rather than an empty notification body', async () => {
      mockUsers(customer, artisan);
      conversationsRepo.findOne.mockResolvedValueOnce({ id: 7 });
      messagesRepo.findOne.mockResolvedValueOnce({ id: 102, sender: customer });

      await service.send(customer.id, {
        recipientId: artisan.id,
        attachmentUrl: `/uploads/messages/${UUID}.jpg`,
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

  /**
   * C1: once a counterparty deletes their account, the relation comes back
   * `null` (TypeORM appends `AND users.deleted_at IS NULL` to the LEFT join,
   * and `conversations` is not itself soft-deletable). The thread must keep
   * working for the party who is still there, with a name it can render —
   * `requirements.md` edge case: "the anonymized name renders, the thread
   * doesn't 500". QA's repro for the 500 lives in
   * `__qa__/deleted-participant-thread.qa.spec.ts`; this covers what the
   * surviving payload actually says.
   */
  describe('a soft-deleted counterparty', () => {
    /** What the repository hands back once one side is soft-deleted. */
    const conversationRow = (slot: 'A' | 'B') => ({
      id: 7,
      participantA: slot === 'A' ? null : customer,
      participantB: slot === 'B' ? null : artisan,
      lastMessageAt: null,
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
    });

    const stubConversationPage = (rows: unknown[]) => {
      const qb: Record<string, unknown> = {
        getManyAndCount: () => Promise.resolve([rows, rows.length]),
      };
      for (const method of [
        'leftJoinAndSelect',
        'where',
        'orderBy',
        'skip',
        'take',
      ]) {
        qb[method] = () => qb;
      }
      conversationsRepo.createQueryBuilder.mockReturnValue(qb);
    };

    it('names the departed contact "Deleted User" instead of dropping the name keys', async () => {
      stubConversationPage([conversationRow('A')]);

      const result = await service.getConversations(artisan.id, {});

      // Emitting `undefined` here dropped both keys from the JSON, and the
      // frontend rendered the row as "undefined undefined" (qa-report FE-7).
      const [row] = result.data;
      expect(row.contact.firstname).toBe('Deleted');
      expect(row.contact.lastname).toBe('User');
      expect(row.participantA.firstname).toBe('Deleted');
      expect(row.participantA.lastname).toBe('User');
      // Same placeholder the purge writes onto the row itself, so the thread
      // reads identically inside the window and after the purge.
      expect(`${row.contact.firstname} ${row.contact.lastname}`).toBe(
        'Deleted User',
      );
    });

    it('leaves the surviving participant untouched', async () => {
      stubConversationPage([conversationRow('B')]);

      const result = await service.getConversations(customer.id, {});

      const [row] = result.data;
      expect(row.participantA.firstname).toBe('Ama');
      expect(row.contact.firstname).toBe('Deleted');
    });

    it('serves the thread to the surviving party in either slot', async () => {
      for (const slot of ['A', 'B'] as const) {
        conversationsRepo.findOne.mockResolvedValueOnce(conversationRow(slot));
        const caller = slot === 'A' ? artisan : customer;

        await expect(
          service.getMessages(caller.id, 7, {}),
        ).resolves.toBeDefined();
      }
    });

    it('still refuses a stranger when one participant is null', async () => {
      conversationsRepo.findOne.mockResolvedValueOnce(conversationRow('A'));

      // The null guard must not turn "a participant is missing" into "anyone
      // may read this thread".
      await expect(
        service.getMessages(otherCustomer.id, 7, {}),
      ).rejects.toThrow(ForbiddenException);
    });

    it('labels each side of an admin dispute view from the dispute, not from the surviving party', async () => {
      // The customer deleted their account; the artisan is still live.
      conversationsRepo.findOne.mockResolvedValueOnce({
        id: 7,
        participantA: null,
        participantB: artisan,
      });
      messagesRepo.count.mockResolvedValueOnce(1);
      messagesRepo.find.mockResolvedValueOnce([
        { id: 1, content: 'first', sender: artisan },
      ]);

      const result = await service.getConversationBetween(
        customer.id,
        artisan.id,
        { disputeId: 12, bookingId: 34 },
      );

      // The departed side must not be mistaken for the surviving one.
      expect(result.data!.customer.firstname).toBe('Deleted');
      expect(result.data!.customer.role).toBe(Role.CUSTOMER);
      expect(result.data!.artisan.id).toBe(artisan.id);
      expect(result.data!.artisan.firstname).toBe('Yaw');
      expect(result.data!.artisan.role).toBe(Role.ARTISAN);
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
