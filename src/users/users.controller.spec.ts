import { Test, TestingModule } from '@nestjs/testing';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

describe('UsersController', () => {
  let controller: UsersController;
  let usersService: UsersService;

  const mockUsersService = {
    create: jest.fn(),
    findAll: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        { provide: UsersService, useValue: mockUsersService },
      ],
    }).compile();

    controller = module.get<UsersController>(UsersController);
    usersService = module.get<UsersService>(UsersService);

    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('create', () => {
    it('should call usersService.create with dto and return result', async () => {
      const dto: CreateUserDto = { name: 'Test' } as CreateUserDto;
      const expected = { id: 1, ...dto };
      mockUsersService.create.mockResolvedValue(expected);

      const result = await controller.create(dto);
      expect(usersService.create).toHaveBeenCalledWith(dto);
      expect(result).toEqual(expected);
    });
  });

  describe('findAll', () => {
    it('should call usersService.findAll and return result', () => {
      mockUsersService.findAll.mockReturnValue('all users');
      const result = controller.findAll();
      expect(usersService.findAll).toHaveBeenCalled();
      expect(result).toBe('all users');
    });
  });

  describe('findOne', () => {
    it('should call usersService.findOne with id and return result', () => {
      mockUsersService.findOne.mockReturnValue('user');
      const result = controller.findOne('5');
      expect(usersService.findOne).toHaveBeenCalledWith(5);
      expect(result).toBe('user');
    });
  });

  describe('update', () => {
    it('should call usersService.update with id and dto and return result', () => {
      const dto: UpdateUserDto = { name: 'Updated' } as UpdateUserDto;
      mockUsersService.update.mockReturnValue('updated');
      const result = controller.update('3', dto);
      expect(usersService.update).toHaveBeenCalledWith(3, dto);
      expect(result).toBe('updated');
    });
  });

  describe('remove', () => {
    it('should call usersService.remove with id and return result', () => {
      mockUsersService.remove.mockReturnValue('removed');
      const result = controller.remove('2');
      expect(usersService.remove).toHaveBeenCalledWith(2);
      expect(result).toBe('removed');
    });
  });
});
