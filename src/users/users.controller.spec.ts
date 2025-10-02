import { Test, TestingModule } from '@nestjs/testing';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';

describe('UsersController', () => {
  let controller: UsersController;
  let usersService: UsersService;

  const mockUsersService = {
    createUser: jest.fn(),
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

  describe('createUser', () => {
    it('should call usersService.createUser with dto and return result', async () => {
      const dto: CreateUserDto = { email: 'test@example.com', password: 'pass' } as CreateUserDto;
      const expected = { id: 1, email: dto.email };
      mockUsersService.createUser.mockResolvedValueOnce(expected);

      const result = await controller.createUser(dto);

      expect(usersService.createUser).toHaveBeenCalledWith(dto);
      expect(result).toEqual(expected);
    });
  });
});
