import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PortfolioService } from './portfolio.service';
import { PortfolioItem } from './entities/portfolio-item.entity';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { StorageProviderFactory } from '../uploads/providers/storage-provider.factory';
import { PortfolioStatus, Role } from '@common/types/enums';

// `assertValidFile` loads the ESM-only `file-type` package via `loadEsm()`
// (real dynamic `import()`), which Node handles natively but Jest's default
// CJS test environment can't (`--experimental-vm-modules` isn't enabled here
// project-wide). Mocking `load-esm` keeps this a true unit test of
// PortfolioService's own logic without depending on that Jest/ESM
// interop gap — the real magic-byte sniffing behavior is exercised at
// runtime, outside Jest's sandboxed VM.
jest.mock('load-esm', () => ({
  loadEsm: jest.fn().mockResolvedValue({
    fileTypeFromBuffer: (buffer: Buffer) =>
      Promise.resolve(
        buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
          ? { ext: 'jpg', mime: 'image/jpeg' }
          : undefined,
      ),
  }),
}));

describe('PortfolioService', () => {
  let service: PortfolioService;

  const mockPortfolioRepo = {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn((data: Record<string, unknown>) => data),
    save: jest.fn(),
    delete: jest.fn(),
    createQueryBuilder: jest.fn(),
  };

  const mockProfileRepo = {
    findOne: jest.fn(),
  };

  const mockProvider = {
    providerName: 'local',
    upload: jest.fn(),
    delete: jest.fn(),
  };

  const mockStorageFactory = {
    getProvider: jest.fn(() => mockProvider),
  };

  const mockEventEmitter = {
    emit: jest.fn(),
  };

  // Real JPEG magic-number bytes (FF D8 FF E0 ... "JFIF") — assertValidFile
  // now sniffs actual file content (via `file-type`), not just the
  // client-declared mimetype, so a placeholder buffer like `Buffer.from
  // ('fake')` would fail validation even though its declared mimetype is
  // allow-listed.
  const validFile = {
    buffer: Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46,
    ]),
    originalname: 'photo.jpg',
    mimetype: 'image/jpeg',
    size: 1024,
  } as Express.Multer.File;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PortfolioService,
        {
          provide: getRepositoryToken(PortfolioItem),
          useValue: mockPortfolioRepo,
        },
        {
          provide: getRepositoryToken(ArtisanProfile),
          useValue: mockProfileRepo,
        },
        { provide: StorageProviderFactory, useValue: mockStorageFactory },
        { provide: EventEmitter2, useValue: mockEventEmitter },
      ],
    }).compile();

    service = module.get<PortfolioService>(PortfolioService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create (PF2)', () => {
    it('rejects an unsupported file type before touching the database', async () => {
      await expect(
        service.create(
          1,
          { ...validFile, mimetype: 'application/pdf' },
          { tag: 'Plumbing' },
        ),
      ).rejects.toThrow(BadRequestException);
      expect(mockProfileRepo.findOne).not.toHaveBeenCalled();
    });

    it('rejects a file over the 50MB limit', async () => {
      await expect(
        service.create(
          1,
          { ...validFile, size: 51 * 1024 * 1024 },
          { tag: 'Plumbing' },
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects when no artisan profile exists for the caller', async () => {
      mockProfileRepo.findOne.mockResolvedValueOnce(null);
      await expect(
        service.create(1, validFile, { tag: 'Plumbing' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('creates a PENDING item and stores the file via the active provider', async () => {
      mockProfileRepo.findOne.mockResolvedValueOnce({ id: 12 });
      mockProvider.upload.mockResolvedValueOnce({
        url: '/uploads/portfolio/uuid.jpg',
        filename: 'uuid.jpg',
        folder: 'portfolio',
        sizeBytes: 1024,
      });
      mockPortfolioRepo.createQueryBuilder.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({ max: null }),
      });
      mockPortfolioRepo.save.mockImplementation(
        (item: Record<string, unknown>) => ({
          id: 1,
          ...item,
        }),
      );

      const result = await service.create(1, validFile, {
        tag: 'Plumbing',
        caption: 'Nice job',
      });

      expect(mockProvider.upload).toHaveBeenCalledWith(
        validFile.buffer,
        expect.objectContaining({ folder: 'portfolio' }),
      );
      expect(result.data.status).toBe(PortfolioStatus.PENDING);
      expect(result.data.artisanId).toBe(12);
    });
  });

  describe('findByArtisan (PF3)', () => {
    const queryBuilderMock = () => ({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    });

    it('404s when the artisan profile does not exist', async () => {
      mockProfileRepo.findOne.mockResolvedValueOnce(null);
      await expect(service.findByArtisan(999)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('filters to APPROVED-only for a non-owning caller', async () => {
      mockProfileRepo.findOne.mockResolvedValueOnce({
        id: 12,
        user: { id: 5 },
      });
      const qb = queryBuilderMock();
      mockPortfolioRepo.createQueryBuilder.mockReturnValue(qb);

      await service.findByArtisan(12, { id: 999, role: Role.CUSTOMER });

      expect(qb.andWhere).toHaveBeenCalledWith('p.status = :status', {
        status: PortfolioStatus.APPROVED,
      });
    });

    it('does not restrict by status for the owning artisan', async () => {
      mockProfileRepo.findOne.mockResolvedValueOnce({
        id: 12,
        user: { id: 5 },
      });
      const qb = queryBuilderMock();
      mockPortfolioRepo.createQueryBuilder.mockReturnValue(qb);

      await service.findByArtisan(12, { id: 5, role: Role.ARTISAN });

      expect(qb.andWhere).not.toHaveBeenCalled();
    });
  });

  describe('remove / reorder ownership (PF3)', () => {
    it('404s deleting an item that does not belong to the caller', async () => {
      mockPortfolioRepo.findOne.mockResolvedValueOnce(null);
      await expect(service.remove(1, 55)).rejects.toThrow(NotFoundException);
    });

    it('404s reordering an item that does not belong to the caller', async () => {
      mockPortfolioRepo.findOne.mockResolvedValueOnce(null);
      await expect(service.reorder(1, 55, { sortOrder: 2 })).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('resubmit (PF7a)', () => {
    it('rejects resubmitting an item that is not currently REJECTED', async () => {
      mockPortfolioRepo.findOne.mockResolvedValueOnce({
        id: 1,
        status: PortfolioStatus.PENDING,
        fileUrl: '/uploads/portfolio/old.jpg',
        fileType: 'image/jpeg',
      });
      await expect(service.resubmit(1, 1, validFile, {})).rejects.toThrow(
        BadRequestException,
      );
    });

    it('resets a REJECTED item to PENDING and clears rejectionReason', async () => {
      mockPortfolioRepo.findOne.mockResolvedValueOnce({
        id: 1,
        status: PortfolioStatus.REJECTED,
        rejectionReason: 'Too blurry',
        fileUrl: '/uploads/portfolio/old.jpg',
        fileType: 'image/jpeg',
      });
      mockProvider.upload.mockResolvedValueOnce({
        url: '/uploads/portfolio/new.jpg',
        filename: 'new.jpg',
        folder: 'portfolio',
        sizeBytes: 1024,
      });
      mockPortfolioRepo.save.mockImplementation(
        (item: Record<string, unknown>) => item,
      );

      const result = await service.resubmit(1, 1, validFile, {});

      expect(result.data.status).toBe(PortfolioStatus.PENDING);
      // Must be `null`, not `undefined` — TypeORM's save() silently omits
      // `undefined` properties from the generated UPDATE, so only an
      // explicit `null` actually clears the column in Postgres.
      expect(result.data.rejectionReason).toBeNull();
      expect(mockProvider.delete).toHaveBeenCalledWith('old.jpg', 'portfolio');
    });
  });

  describe('admin moderation (PF4)', () => {
    it('emits PORTFOLIO_APPROVED on approve', async () => {
      mockPortfolioRepo.findOne.mockResolvedValueOnce({
        id: 1,
        artisanProfile: { user: { id: 7 } },
      });
      mockPortfolioRepo.save.mockResolvedValueOnce({});

      await service.approve(1);

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'portfolio.approved',
        expect.objectContaining({ artisanUserId: 7, portfolioItemId: 1 }),
      );
    });

    it('emits PORTFOLIO_REJECTED with the reason on reject', async () => {
      mockPortfolioRepo.findOne.mockResolvedValueOnce({
        id: 1,
        artisanProfile: { user: { id: 7 } },
      });
      mockPortfolioRepo.save.mockResolvedValueOnce({});

      await service.reject(1, { rejectionReason: 'Too blurry to evaluate' });

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'portfolio.rejected',
        expect.objectContaining({
          artisanUserId: 7,
          portfolioItemId: 1,
          reason: 'Too blurry to evaluate',
        }),
      );
    });
  });
});
