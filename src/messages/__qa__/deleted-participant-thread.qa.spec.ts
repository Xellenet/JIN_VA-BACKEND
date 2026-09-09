import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ForbiddenException } from '@nestjs/common';
import { MessagesService } from '../messages.service';
import { Message } from '../entities/message.entity';
import { Conversation } from '../entities/conversation.entity';
import { User } from '@users/entities/user.entity';
import { Job } from '@jobs/entities/job.entity';
import { Booking } from '../../bookings/entities/booking.entity';
import { Role } from '@common/types/enums';

/**
 * QA regression coverage for **qa-report.md B7** (= security-report.md M7).
 *
 * `requirements.md` (C1, Edge cases): *"A counterparty is mid-conversation with
 * someone who deletes. Messaging threads and notifications referencing a
 * soft-deleted user must not break for the other party during the window or
 * after purge — the anonymized name renders, the thread doesn't 500."*
 *
 * `Conversation.participantA` / `participantB` are `ManyToOne(() => User)`, so
 * TypeORM appends `AND <alias>.deleted_at IS NULL` to the relation's LEFT join.
 * `conversations` is not itself soft-deletable, so once one participant deletes
 * their account the row still loads with that side `null`. `assertParticipant`
 * compares `conversation.participantA.id` before the `||` can short-circuit, so
 * the *participantA-deleted* case throws a `TypeError` → 500, while the
 * *participantB-deleted* case happens to pass. Half of all affected threads
 * break, non-deterministically from the user's point of view.
 *
 * Reproduced live on 2026-09-08 (conversation 150, `participant_a_id` deleted):
 *   GET   /api/v1/messages/150       -> 500 "Cannot read properties of null (reading 'id')"
 *   PATCH /api/v1/messages/150/read  -> 500 "Cannot read properties of null (reading 'id')"
 *
 * These are **expected to fail until B7 is fixed** and are deliberately left
 * red as living evidence, in the same way round 1 left B3/B5 red. The fix is
 * optional chaining in `assertParticipant` (and the same shape at the admin
 * dispute-conversation call site); when it lands, all four cases below pass
 * with no change to this file.
 *
 * Test code only — no feature code is touched by this spec.
 */
describe('MessagesService — soft-deleted participant (QA B7)', () => {
  let service: MessagesService;

  const liveArtisan = {
    id: 2,
    firstname: 'Yaw',
    lastname: 'Boateng',
    role: Role.ARTISAN,
  } as User;

  const liveCustomer = {
    id: 1,
    firstname: 'Ama',
    lastname: 'Mensah',
    role: Role.CUSTOMER,
  } as User;

  let messagesRepo: {
    findAndCount: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let conversationsRepo: { findOne: jest.Mock };

  /**
   * What the repository actually hands back once one side is soft-deleted: the
   * conversation row, with the deleted participant nulled by the soft-delete
   * filter on the join. Cast because the entity types both sides as non-null,
   * which is exactly the assumption this finding disproves at runtime.
   */
  const conversationWithDeleted = (slot: 'A' | 'B') =>
    ({
      id: 150,
      participantA: slot === 'A' ? null : liveCustomer,
      participantB: slot === 'B' ? null : liveArtisan,
    }) as unknown as Conversation;

  beforeEach(async () => {
    messagesRepo = {
      findAndCount: jest.fn().mockResolvedValue([[], 0]),
      createQueryBuilder: jest.fn(() => ({
        update: () => ({
          set: () => ({ where: () => ({ execute: () => Promise.resolve() }) }),
        }),
      })),
    };
    conversationsRepo = { findOne: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessagesService,
        { provide: getRepositoryToken(Message), useValue: messagesRepo },
        {
          provide: getRepositoryToken(Conversation),
          useValue: conversationsRepo,
        },
        { provide: getRepositoryToken(User), useValue: { findOne: jest.fn() } },
        { provide: getRepositoryToken(Job), useValue: { findOne: jest.fn() } },
        {
          provide: getRepositoryToken(Booking),
          useValue: { findOne: jest.fn() },
        },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    }).compile();

    service = module.get<MessagesService>(MessagesService);
  });

  describe('the live party opens the thread (GET /messages/:id)', () => {
    it('does not 500 when the DELETED counterparty is in the participantA slot', async () => {
      conversationsRepo.findOne.mockResolvedValue(conversationWithDeleted('A'));

      // The live caller is participantB. This must resolve, not throw a
      // TypeError — a user asking for their own conversation may never get a
      // 500 because the other party left.
      await expect(
        service.getMessages(liveArtisan.id, 150, {}),
      ).resolves.toBeDefined();
    });

    it('still works when the deleted counterparty is in the participantB slot (the half that already passes)', async () => {
      conversationsRepo.findOne.mockResolvedValue(conversationWithDeleted('B'));

      await expect(
        service.getMessages(liveCustomer.id, 150, {}),
      ).resolves.toBeDefined();
    });

    it('still refuses a genuine non-participant rather than failing open', async () => {
      conversationsRepo.findOne.mockResolvedValue(conversationWithDeleted('A'));

      // A stranger must keep getting 403. Whatever null-guard fixes this must
      // not turn "one participant is null" into "anyone may read the thread".
      await expect(service.getMessages(999, 150, {})).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('the live party marks the thread read (PATCH /messages/:id/read)', () => {
    it('does not 500 when the DELETED counterparty is in the participantA slot', async () => {
      conversationsRepo.findOne.mockResolvedValue(conversationWithDeleted('A'));

      await expect(
        service.markRead(liveArtisan.id, 150),
      ).resolves.toBeDefined();
    });
  });
});
