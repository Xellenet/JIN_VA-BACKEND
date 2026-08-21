import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { FavouritesService } from './favourites.service';
import { Favourite } from './entities/favourite.entity';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { Job } from '@jobs/entities/job.entity';
import { Status } from '@common/types/enums';

describe('FavouritesService', () => {
  let service: FavouritesService;

  const savedAt = new Date('2026-08-01T00:00:00.000Z');
  const favouriteRow = {
    id: 1,
    createdAt: savedAt,
    artisan: {
      id: 7,
      businessName: 'Kofi Home Services',
      averageRating: 4.5,
      totalReviews: 12,
      isVerified: true,
      services: [],
      user: { id: 42, firstname: 'Kofi', lastname: 'Mensah' },
    },
  };

  const mockQb = {
    innerJoin: jest.fn().mockReturnThis(),
    innerJoinAndSelect: jest.fn().mockReturnThis(),
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn().mockResolvedValue([[favouriteRow], 1]),
    getRawMany: jest
      .fn()
      .mockResolvedValue([{ artisanUserId: '42', count: '6' }]),
  };

  const mockFavouritesRepo = {
    createQueryBuilder: jest.fn().mockReturnValue(mockQb),
  };
  const mockArtisanProfileRepo = { findOne: jest.fn() };
  const mockJobsRepo = {
    createQueryBuilder: jest.fn().mockReturnValue(mockQb),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockFavouritesRepo.createQueryBuilder.mockReturnValue(mockQb);
    mockJobsRepo.createQueryBuilder.mockReturnValue(mockQb);
    mockQb.getManyAndCount.mockResolvedValue([[favouriteRow], 1]);
    mockQb.getRawMany.mockResolvedValue([{ artisanUserId: '42', count: '6' }]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FavouritesService,
        {
          provide: getRepositoryToken(Favourite),
          useValue: mockFavouritesRepo,
        },
        {
          provide: getRepositoryToken(ArtisanProfile),
          useValue: mockArtisanProfileRepo,
        },
        { provide: getRepositoryToken(Job), useValue: mockJobsRepo },
      ],
    }).compile();

    service = module.get(FavouritesService);
  });

  it('includes favouritedAt (the join row createdAt) and completedJobsCount per artisan', async () => {
    const result = await service.findAll(1, {});

    expect(result.data).toHaveLength(1);
    expect(result.data[0].favouritedAt).toEqual(savedAt);
    expect(result.data[0].completedJobsCount).toBe(6);

    expect(mockJobsRepo.createQueryBuilder).toHaveBeenCalled();
    expect(mockQb.andWhere).toHaveBeenCalledWith('job.status = :status', {
      status: Status.COMPLETED,
    });
  });

  it('defaults completedJobsCount to 0 when the artisan has no completed jobs', async () => {
    mockQb.getRawMany.mockResolvedValueOnce([]);
    const result = await service.findAll(1, {});
    expect(result.data[0].completedJobsCount).toBe(0);
  });

  it('skips the completed-jobs query entirely when there are no favourites', async () => {
    mockQb.getManyAndCount.mockResolvedValueOnce([[], 0]);
    const result = await service.findAll(1, {});
    expect(result.data).toHaveLength(0);
    expect(mockJobsRepo.createQueryBuilder).not.toHaveBeenCalled();
  });
});
