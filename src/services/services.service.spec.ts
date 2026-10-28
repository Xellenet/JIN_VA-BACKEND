import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ILike, type Repository } from 'typeorm';
import type { ServiceEntity } from './entities/service.entity';
import { ServicesService } from './services.service';

describe('ServicesService', () => {
  let nameQb: { where: jest.Mock; andWhere: jest.Mock; getOne: jest.Mock };
  let repo: {
    createQueryBuilder: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    findAndCount: jest.Mock;
    delete: jest.Mock;
    manager: { query: jest.Mock };
  };
  let service: ServicesService;

  beforeEach(() => {
    nameQb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(null),
    };
    repo = {
      createQueryBuilder: jest.fn(() => nameQb),
      create: jest.fn((dto: object) => ({ ...dto })),
      save: jest.fn((s: object) => Promise.resolve({ id: 12, ...s })),
      findOne: jest.fn(),
      findAndCount: jest.fn(),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      manager: { query: jest.fn() },
    };
    service = new ServicesService(repo as unknown as Repository<ServiceEntity>);
  });

  describe('create', () => {
    it('saves a service whose name is free', async () => {
      const result = await service.create({ name: 'Roofing' } as never);

      expect(nameQb.where).toHaveBeenCalledWith(
        'LOWER(s.name) = LOWER(:name)',
        { name: 'Roofing' },
      );
      expect(nameQb.andWhere).not.toHaveBeenCalled();
      expect(repo.save).toHaveBeenCalledWith({ name: 'Roofing' });
      expect(result.data).toMatchObject({ id: 12, name: 'Roofing' });
    });

    it('rejects a name that already exists in any case (QA ADM-10)', async () => {
      nameQb.getOne.mockResolvedValue({ id: 3, name: 'roofing' });
      await expect(
        service.create({ name: 'ROOFING' } as never),
      ).rejects.toThrow(BadRequestException);
      expect(repo.save).not.toHaveBeenCalled();
    });
  });

  describe('findAll', () => {
    it('defaults to page 1 of 100, newest first, unfiltered', async () => {
      repo.findAndCount.mockResolvedValue([[{ id: 1, name: 'Masonry' }], 1]);
      const result = await service.findAll({});

      expect(repo.findAndCount).toHaveBeenCalledWith({
        where: {},
        order: { id: 'DESC' },
        skip: 0,
        take: 100,
      });
      expect(result.pagination).toEqual({
        total: 1,
        page: 1,
        limit: 100,
        totalPages: 1,
      });
      expect(result.data).toHaveLength(1);
    });

    it('filters by a case-insensitive name substring and pages', async () => {
      repo.findAndCount.mockResolvedValue([[], 25]);
      const result = await service.findAll({
        search: 'pla',
        page: 2,
        limit: 10,
      } as never);

      expect(repo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { name: ILike('%pla%') },
          skip: 10,
          take: 10,
        }),
      );
      expect(result.pagination.totalPages).toBe(3);
    });
  });

  describe('findOne', () => {
    it('404s for an unknown id', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.findOne(404)).rejects.toThrow(NotFoundException);
    });

    it('returns the service', async () => {
      repo.findOne.mockResolvedValue({ id: 4, name: 'Carpentry' });
      const result = await service.findOne(4);
      expect(repo.findOne).toHaveBeenCalledWith({ where: { id: 4 } });
      expect(result.data).toMatchObject({ id: 4, name: 'Carpentry' });
    });
  });

  describe('update', () => {
    it('404s for an unknown id', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.update(9, { name: 'X' } as never)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('skips the uniqueness check when the name only changes case', async () => {
      repo.findOne.mockResolvedValue({ id: 4, name: 'Carpentry' });
      await service.update(4, { name: 'CARPENTRY' } as never);
      expect(repo.createQueryBuilder).not.toHaveBeenCalled();
      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 4, name: 'CARPENTRY' }),
      );
    });

    it('skips the uniqueness check when no name is sent', async () => {
      repo.findOne.mockResolvedValue({ id: 4, name: 'Carpentry' });
      await service.update(4, { description: 'Wood work' } as never);
      expect(repo.createQueryBuilder).not.toHaveBeenCalled();
      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ description: 'Wood work' }),
      );
    });

    it('checks a new name against every other service', async () => {
      repo.findOne.mockResolvedValue({ id: 4, name: 'Carpentry' });
      const result = await service.update(4, { name: 'Joinery' } as never);
      expect(nameQb.andWhere).toHaveBeenCalledWith('s.id <> :exceptId', {
        exceptId: 4,
      });
      expect(result.data).toMatchObject({ name: 'Joinery' });
    });

    it('rejects a rename onto another service name', async () => {
      repo.findOne.mockResolvedValue({ id: 4, name: 'Carpentry' });
      nameQb.getOne.mockResolvedValue({ id: 5, name: 'Joinery' });
      await expect(
        service.update(4, { name: 'joinery' } as never),
      ).rejects.toThrow(BadRequestException);
      expect(repo.save).not.toHaveBeenCalled();
    });
  });

  describe('remove (QA ADM-12)', () => {
    beforeEach(() => repo.findOne.mockResolvedValue({ id: 4, name: 'Tiling' }));

    const usage = (artisans: number, bookings: number, jobs: number) =>
      repo.manager.query.mockResolvedValue([{ artisans, bookings, jobs }]);

    it('404s before checking usage when the service does not exist', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.remove(4)).rejects.toThrow(NotFoundException);
      expect(repo.manager.query).not.toHaveBeenCalled();
    });

    it('deletes an unused service', async () => {
      usage(0, 0, 0);
      const result = await service.remove(4);
      expect(repo.manager.query).toHaveBeenCalledWith(expect.any(String), [4]);
      expect(repo.delete).toHaveBeenCalledWith(4);
      expect(result.message).toBeDefined();
    });

    it('refuses while artisans offer it and says to remove it from profiles', async () => {
      usage(1, 0, 0);
      const err = await service.remove(4).catch((e: Error) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.message).toBe(
        "This service can't be deleted because 1 artisan offers it. Ask those artisans to remove it from their profile first.",
      );
      expect(repo.delete).not.toHaveBeenCalled();
    });

    it('lists every kind of use, pluralised, and keeps history-bearing services', async () => {
      usage(3, 1, 2);
      const err = await service.remove(4).catch((e: Error) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.message).toContain(
        'because 3 artisans offer, 1 booking uses, 2 jobs use it.',
      );
      expect(err.message).toContain('booking or job history are kept');
    });

    it('treats job-only usage as history', async () => {
      usage(0, 0, 1);
      const err = await service.remove(4).catch((e: Error) => e);
      expect(err.message).toContain('because 1 job uses it.');
      expect(err.message).toContain('booking or job history are kept');
    });

    it('pluralises multiple bookings', async () => {
      usage(0, 2, 0);
      const err = await service.remove(4).catch((e: Error) => e);
      expect(err.message).toContain('because 2 bookings use it.');
    });
  });
});
