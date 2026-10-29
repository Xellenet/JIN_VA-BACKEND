import { PortfolioController } from './portfolio.controller';
import type { PortfolioService } from './portfolio.service';
import type { User } from '@users/entities/user.entity';
import type { AuthenticatedRequest } from '@common/types/authenticated-request.type';
import { Role } from '@common/types/enums';

describe('PortfolioController', () => {
  let controller: PortfolioController;

  const mockService = {
    create: jest.fn(),
    findByArtisan: jest.fn(),
    remove: jest.fn(),
    reorder: jest.fn(),
    resubmit: jest.fn(),
  };

  const artisan = {
    id: 7,
    email: 'artisan@example.com',
    role: Role.ARTISAN,
  } as User;
  const reqAs = (user?: User) => ({ user }) as AuthenticatedRequest;

  const file = {
    originalname: 'work.jpg',
    mimetype: 'image/jpeg',
    size: 1024,
    buffer: Buffer.from([0xff, 0xd8, 0xff]),
  } as Express.Multer.File;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new PortfolioController(
      mockService as unknown as PortfolioService,
    );
  });

  it('create forwards the caller id, uploaded file and DTO', async () => {
    const dto = { tag: 'Plumbing', caption: 'Bathroom refit' };
    const response = { message: 'created', data: { id: 1 } };
    mockService.create.mockResolvedValue(response);

    await expect(controller.create(reqAs(artisan), file, dto)).resolves.toBe(
      response,
    );
    expect(mockService.create).toHaveBeenCalledWith(7, file, dto);
  });

  it('findByArtisan passes the artisan id and the (possibly authenticated) viewer', async () => {
    const response = { message: 'ok', data: [] };
    mockService.findByArtisan.mockResolvedValue(response);

    await expect(controller.findByArtisan(reqAs(artisan), 3)).resolves.toBe(
      response,
    );
    expect(mockService.findByArtisan).toHaveBeenCalledWith(3, artisan);
  });

  it('findByArtisan passes an undefined viewer for anonymous callers', async () => {
    mockService.findByArtisan.mockResolvedValue({ data: [] });

    await controller.findByArtisan(reqAs(undefined), 3);

    expect(mockService.findByArtisan).toHaveBeenCalledWith(3, undefined);
  });

  it('remove forwards the caller id and item id', async () => {
    const response = { message: 'deleted' };
    mockService.remove.mockResolvedValue(response);

    await expect(controller.remove(reqAs(artisan), 12)).resolves.toBe(response);
    expect(mockService.remove).toHaveBeenCalledWith(7, 12);
  });

  it('reorder forwards the caller id, item id and new sort order', async () => {
    const dto = { sortOrder: 2 };
    const response = { message: 'reordered', data: { id: 12, sortOrder: 2 } };
    mockService.reorder.mockResolvedValue(response);

    await expect(controller.reorder(reqAs(artisan), 12, dto)).resolves.toBe(
      response,
    );
    expect(mockService.reorder).toHaveBeenCalledWith(7, 12, dto);
  });

  it('resubmit forwards the caller id, item id, new file and DTO', async () => {
    const dto = { caption: 'Retaken photo' };
    const response = { message: 'resubmitted', data: { id: 12 } };
    mockService.resubmit.mockResolvedValue(response);

    await expect(
      controller.resubmit(reqAs(artisan), 12, file, dto),
    ).resolves.toBe(response);
    expect(mockService.resubmit).toHaveBeenCalledWith(7, 12, file, dto);
  });
});
