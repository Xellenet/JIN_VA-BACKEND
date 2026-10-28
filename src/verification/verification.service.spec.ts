import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { VerificationService } from './verification.service';
import { ArtisanVerification } from './entities/artisan-verification.entity';
import { VerificationProviderFactory } from './providers/verification-provider.factory';
import { AdminAuditService } from '../admin-audit/admin-audit.service';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import type { User } from '@users/entities/user.entity';
import { APP_EVENTS } from '@common/events/app.events';
import {
  AdminActionTarget,
  AdminActionType,
  DocumentType,
  VerificationStatus,
} from '@common/types/enums';
import type { SubmitVerificationDto } from './dto/submit-verification.dto';

describe('VerificationService', () => {
  let service: VerificationService;

  const mockRepo = {
    findOne: jest.fn(),
    create: jest.fn((data: Record<string, unknown>) => ({ ...data })),
    save: jest.fn(),
    createQueryBuilder: jest.fn(),
  };

  const mockProfileRepo = {
    findOne: jest.fn(),
    save: jest.fn(),
  };

  const mockProvider = {
    providerName: 'manual',
    initiate: jest.fn(),
  };

  const mockProviderFactory = {
    getProvider: jest.fn(() => mockProvider),
  };

  const mockEventEmitter = { emit: jest.fn() };

  const mockAuditService = {
    record: jest.fn().mockResolvedValue(undefined),
  };

  const actingAdmin = {
    id: 99,
    firstname: 'Admin',
    lastname: 'One',
    email: 'admin@example.com',
  } as User;

  const artisanUser = {
    id: 7,
    firstname: 'Ama',
    lastname: 'Mensah',
    email: 'ama@example.com',
  };

  const submitDto: SubmitVerificationDto = {
    documentType: DocumentType.GHANA_CARD,
    idNumber: 'GHA-000000000-0',
    fullLegalName: 'Ama Mensah',
    dateOfBirth: '1990-01-01',
    documentFrontUrl: 'https://cdn.example.com/front.jpg',
    documentBackUrl: 'https://cdn.example.com/back.jpg',
    selfieUrl: 'https://cdn.example.com/selfie.jpg',
    additionalNotes: 'Please review',
  } as SubmitVerificationDto;

  const buildProfile = (overrides: Partial<ArtisanProfile> = {}) =>
    ({
      id: 3,
      isVerified: false,
      user: { ...artisanUser },
      ...overrides,
    }) as unknown as ArtisanProfile;

  const buildVerification = (
    status: VerificationStatus,
    overrides: Record<string, unknown> = {},
  ) =>
    ({
      id: 11,
      status,
      artisanProfileId: 3,
      artisanProfile: buildProfile(),
      ...overrides,
    }) as unknown as ArtisanVerification;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockRepo.save.mockImplementation((v: Record<string, unknown>) =>
      Promise.resolve(Object.assign(v, { id: v.id ?? 11 })),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VerificationService,
        {
          provide: getRepositoryToken(ArtisanVerification),
          useValue: mockRepo,
        },
        {
          provide: getRepositoryToken(ArtisanProfile),
          useValue: mockProfileRepo,
        },
        { provide: VerificationProviderFactory, useValue: mockProviderFactory },
        { provide: EventEmitter2, useValue: mockEventEmitter },
        { provide: AdminAuditService, useValue: mockAuditService },
      ],
    }).compile();

    service = module.get<VerificationService>(VerificationService);
  });

  describe('submit', () => {
    it('throws NotFoundException when the artisan profile does not exist', async () => {
      mockProfileRepo.findOne.mockResolvedValue(null);

      await expect(service.submit(7, submitDto)).rejects.toThrow(
        NotFoundException,
      );
      expect(mockRepo.save).not.toHaveBeenCalled();
    });

    it('rejects a submission from an already verified profile', async () => {
      mockProfileRepo.findOne.mockResolvedValue(
        buildProfile({ isVerified: true }),
      );

      await expect(service.submit(7, submitDto)).rejects.toThrow(
        'Your profile is already verified.',
      );
    });

    it('rejects a re-submission while one is still pending or under review', async () => {
      mockProfileRepo.findOne.mockResolvedValue(buildProfile());
      mockRepo.findOne.mockResolvedValue(
        buildVerification(VerificationStatus.UNDER_REVIEW),
      );

      await expect(service.submit(7, submitDto)).rejects.toThrow(
        BadRequestException,
      );
      expect(mockRepo.findOne).toHaveBeenCalledWith({
        where: [
          { artisanProfileId: 3, status: VerificationStatus.PENDING },
          { artisanProfileId: 3, status: VerificationStatus.UNDER_REVIEW },
        ],
      });
      expect(mockRepo.save).not.toHaveBeenCalled();
    });

    it('saves the submission, applies the provider result and emits a submitted event', async () => {
      mockProfileRepo.findOne.mockResolvedValue(buildProfile());
      mockRepo.findOne.mockResolvedValue(null);
      mockProvider.initiate.mockResolvedValue({
        initialStatus: VerificationStatus.PENDING,
        providerReference: 'ref-123',
        rawResponse: { ok: true },
      });

      const result = await service.submit(7, submitDto);

      expect(mockRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          artisanProfileId: 3,
          documentType: DocumentType.GHANA_CARD,
          selfieUrl: submitDto.selfieUrl,
          provider: 'manual',
        }),
      );
      expect(mockProvider.initiate).toHaveBeenCalledWith(
        expect.objectContaining({
          verificationId: 11,
          artisanProfileId: 3,
          idNumber: submitDto.idNumber,
        }),
      );
      expect(mockRepo.save).toHaveBeenCalledTimes(2);
      const persisted = (
        mockRepo.save.mock.calls as ArtisanVerification[][]
      )[1][0];
      expect(persisted.status).toBe(VerificationStatus.PENDING);
      expect(persisted.providerReference).toBe('ref-123');
      expect(persisted.providerRawResponse).toEqual({ ok: true });

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        APP_EVENTS.ARTISAN_VERIFICATION_SUBMITTED,
        { verificationId: 11, artisanUserId: 7, artisanName: 'Ama Mensah' },
      );
      expect(result.message).toMatch(/submitted successfully/);
      expect(result.data).toMatchObject({
        id: 11,
        status: VerificationStatus.PENDING,
        providerReference: 'ref-123',
        documentType: DocumentType.GHANA_CARD,
      });
    });

    it('leaves optional provider fields untouched when the provider omits them', async () => {
      mockProfileRepo.findOne.mockResolvedValue(buildProfile());
      mockRepo.findOne.mockResolvedValue(null);
      mockProvider.initiate.mockResolvedValue({
        initialStatus: VerificationStatus.UNDER_REVIEW,
      });

      const result = await service.submit(7, submitDto);

      const persisted = (
        mockRepo.save.mock.calls as ArtisanVerification[][]
      )[1][0];
      expect(persisted.status).toBe(VerificationStatus.UNDER_REVIEW);
      expect(persisted.providerReference).toBeUndefined();
      expect(persisted.providerRawResponse).toBeUndefined();
      expect(result.data.status).toBe(VerificationStatus.UNDER_REVIEW);
    });

    it('still records the submission and emits the event when the provider fails', async () => {
      mockProfileRepo.findOne.mockResolvedValue(buildProfile());
      mockRepo.findOne.mockResolvedValue(null);
      mockProvider.initiate.mockRejectedValue(new Error('provider down'));

      const result = await service.submit(7, submitDto);

      expect(mockRepo.save).toHaveBeenCalledTimes(1);
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        APP_EVENTS.ARTISAN_VERIFICATION_SUBMITTED,
        expect.objectContaining({ verificationId: 11, artisanUserId: 7 }),
      );
      expect(result.data.id).toBe(11);
    });
  });

  describe('getMyVerification', () => {
    it('throws NotFoundException when the artisan profile does not exist', async () => {
      mockProfileRepo.findOne.mockResolvedValue(null);

      await expect(service.getMyVerification(7)).rejects.toThrow(
        'Artisan profile not found.',
      );
    });

    it('throws NotFoundException when the artisan has never submitted', async () => {
      mockProfileRepo.findOne.mockResolvedValue(buildProfile());
      mockRepo.findOne.mockResolvedValue(null);

      await expect(service.getMyVerification(7)).rejects.toThrow(
        'No verification submission found.',
      );
    });

    it('returns the latest submission for the artisan profile', async () => {
      mockProfileRepo.findOne.mockResolvedValue(buildProfile());
      mockRepo.findOne.mockResolvedValue(
        buildVerification(VerificationStatus.REJECTED, {
          rejectionReason: 'Blurry photo',
        }),
      );

      const result = await service.getMyVerification(7);

      expect(mockRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { artisanProfileId: 3 },
          order: { createdAt: 'DESC' },
        }),
      );
      expect(result.data).toMatchObject({
        id: 11,
        status: VerificationStatus.REJECTED,
        rejectionReason: 'Blurry photo',
        artisanProfile: { id: 3 },
      });
    });
  });

  describe('findAll', () => {
    const buildQb = (records: unknown[], total: number) => {
      const qb = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([records, total]),
      };
      mockRepo.createQueryBuilder.mockReturnValue(qb);
      return qb;
    };

    it('defaults to page 1 / limit 20 without a status filter', async () => {
      const qb = buildQb([buildVerification(VerificationStatus.PENDING)], 1);

      const result = await service.findAll({});

      expect(qb.andWhere).not.toHaveBeenCalled();
      expect(qb.skip).toHaveBeenCalledWith(0);
      expect(qb.take).toHaveBeenCalledWith(20);
      expect(result.pagination).toEqual({
        total: 1,
        page: 1,
        limit: 20,
        totalPages: 1,
      });
      expect(result.data).toHaveLength(1);
    });

    it('filters by status and paginates', async () => {
      const qb = buildQb([], 25);

      const result = await service.findAll({
        status: VerificationStatus.APPROVED,
        page: 3,
        limit: 10,
      });

      expect(qb.andWhere).toHaveBeenCalledWith('v.status = :status', {
        status: VerificationStatus.APPROVED,
      });
      expect(qb.skip).toHaveBeenCalledWith(20);
      expect(qb.take).toHaveBeenCalledWith(10);
      expect(result.pagination.totalPages).toBe(3);
    });
  });

  describe('findOne', () => {
    it('throws NotFoundException for an unknown id', async () => {
      mockRepo.findOne.mockResolvedValue(null);

      await expect(service.findOne(404)).rejects.toThrow(NotFoundException);
    });

    it('returns the record mapped to the response shape', async () => {
      mockRepo.findOne.mockResolvedValue(
        buildVerification(VerificationStatus.PENDING),
      );

      const result = await service.findOne(11);

      expect(result.data).toMatchObject({
        id: 11,
        status: VerificationStatus.PENDING,
      });
      // Only exposed fields survive the mapping.
      expect(result.data).not.toHaveProperty('artisanProfileId');
    });
  });

  describe('startReview', () => {
    it('throws NotFoundException for an unknown id', async () => {
      mockRepo.findOne.mockResolvedValue(null);

      await expect(service.startReview(99, 404)).rejects.toThrow(
        'Verification record not found.',
      );
    });

    it('only allows starting a review on a PENDING submission', async () => {
      mockRepo.findOne.mockResolvedValue(
        buildVerification(VerificationStatus.APPROVED),
      );

      await expect(service.startReview(99, 11)).rejects.toThrow(
        'Cannot start review — current status is APPROVED.',
      );
      expect(mockRepo.save).not.toHaveBeenCalled();
    });

    it('moves PENDING to UNDER_REVIEW and assigns the reviewer', async () => {
      mockRepo.findOne.mockResolvedValue(
        buildVerification(VerificationStatus.PENDING),
      );

      const result = await service.startReview(99, 11);

      expect(mockRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: VerificationStatus.UNDER_REVIEW,
          reviewedById: 99,
          reviewedBy: { id: 99 },
        }),
      );
      expect(result.message).toMatch(/UNDER_REVIEW/);
    });
  });

  describe('approve', () => {
    it('rejects approving an already approved submission', async () => {
      mockRepo.findOne.mockResolvedValue(
        buildVerification(VerificationStatus.APPROVED),
      );

      await expect(service.approve(actingAdmin, 11, {})).rejects.toThrow(
        'This submission is already approved.',
      );
    });

    it('rejects approving a REJECTED submission', async () => {
      mockRepo.findOne.mockResolvedValue(
        buildVerification(VerificationStatus.REJECTED),
      );

      await expect(service.approve(actingAdmin, 11, {})).rejects.toThrow(
        'Cannot approve a submission with status REJECTED.',
      );
      expect(mockProfileRepo.save).not.toHaveBeenCalled();
      expect(mockAuditService.record).not.toHaveBeenCalled();
    });

    it('approves, verifies the profile, emits an event and writes an audit row', async () => {
      const verification = buildVerification(VerificationStatus.UNDER_REVIEW);
      mockRepo.findOne.mockResolvedValue(verification);

      const result = await service.approve(actingAdmin, 11, {
        notes: 'Documents match',
      });

      expect(mockRepo.findOne).toHaveBeenCalledWith({
        where: { id: 11 },
        relations: ['artisanProfile', 'artisanProfile.user'],
      });
      expect(mockRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: VerificationStatus.APPROVED,
          reviewedById: 99,
          adminNotes: 'Documents match',
          reviewedAt: expect.any(Date) as Date,
        }),
      );
      expect(mockProfileRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 3, isVerified: true }),
      );
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        APP_EVENTS.ARTISAN_PROFILE_VERIFIED,
        { artisanUserId: 7 },
      );
      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: AdminActionType.VERIFICATION_APPROVE,
        targetType: AdminActionTarget.VERIFICATION,
        targetId: 11,
        targetLabel: 'Verification #11 · Ama Mensah (ama@example.com)',
        reason: 'Documents match',
        actorId: 99,
        actorName: 'Admin One',
        actorEmail: 'admin@example.com',
        metadata: { artisanProfileId: 3, artisanUserId: 7 },
      });
      expect(result.message).toMatch(/approved/);
    });

    it('approves a PENDING submission without notes and audits a null reason', async () => {
      const verification = buildVerification(VerificationStatus.PENDING);
      mockRepo.findOne.mockResolvedValue(verification);

      await service.approve(actingAdmin, 11, {});

      expect(verification.status).toBe(VerificationStatus.APPROVED);
      expect(verification.adminNotes).toBeUndefined();
      expect(mockAuditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ reason: null }),
      );
    });
  });

  describe('reject', () => {
    it('throws NotFoundException for an unknown id', async () => {
      mockRepo.findOne.mockResolvedValue(null);

      await expect(
        service.reject(actingAdmin, 404, { reason: 'Blurry' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('rejects rejecting an already rejected submission', async () => {
      mockRepo.findOne.mockResolvedValue(
        buildVerification(VerificationStatus.REJECTED),
      );

      await expect(
        service.reject(actingAdmin, 11, { reason: 'Blurry' }),
      ).rejects.toThrow('This submission is already rejected.');
    });

    it('refuses to reject an approved submission', async () => {
      mockRepo.findOne.mockResolvedValue(
        buildVerification(VerificationStatus.APPROVED),
      );

      await expect(
        service.reject(actingAdmin, 11, { reason: 'Blurry' }),
      ).rejects.toThrow('Cannot reject an already approved submission.');
      expect(mockRepo.save).not.toHaveBeenCalled();
    });

    it('rejects with a reason, emits an event and writes an audit row', async () => {
      const verification = buildVerification(VerificationStatus.UNDER_REVIEW);
      mockRepo.findOne.mockResolvedValue(verification);

      const result = await service.reject(actingAdmin, 11, {
        reason: 'Selfie does not match document',
        notes: 'Asked to retake',
      });

      expect(mockRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: VerificationStatus.REJECTED,
          rejectionReason: 'Selfie does not match document',
          adminNotes: 'Asked to retake',
          reviewedById: 99,
        }),
      );
      expect(mockProfileRepo.save).not.toHaveBeenCalled();
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        APP_EVENTS.ARTISAN_VERIFICATION_REJECTED,
        { artisanUserId: 7, reason: 'Selfie does not match document' },
      );
      expect(mockAuditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AdminActionType.VERIFICATION_REJECT,
          reason: 'Selfie does not match document',
          targetId: 11,
        }),
      );
      expect(result.message).toMatch(/rejected/);
    });

    it('falls back to a bare audit label when the artisan user is not loaded', async () => {
      const verification = buildVerification(VerificationStatus.PENDING, {
        artisanProfile: { id: 3, user: { id: 7 } },
      });
      mockRepo.findOne.mockResolvedValue(verification);
      // Simulate the relation going missing after the event fires.
      mockEventEmitter.emit.mockImplementationOnce(() => {
        verification.artisanProfile.user =
          undefined as unknown as ArtisanProfile['user'];
        return true;
      });

      await service.reject(actingAdmin, 11, { reason: 'Expired ID' });

      expect(verification.adminNotes).toBeUndefined();
      expect(mockAuditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          targetLabel: 'Verification #11',
          metadata: { artisanProfileId: 3, artisanUserId: undefined },
        }),
      );
    });
  });
});
