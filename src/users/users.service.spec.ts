import { Test, TestingModule } from '@nestjs/testing';
import { UsersService } from './users.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { User } from './entities/user.entity';
import { Repository } from 'typeorm';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

describe('UsersService', () => {
  let service: UsersService;
  let usersRepository: Repository<User>;

  const mockUser = { id: 1, name: 'Test User' } as User;
  const mockUsersRepository = {
    create: jest.fn().mockImplementation(dto => ({ ...dto, id: 1 })),
    save: jest.fn().mockResolvedValue(mockUser),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        {
          provide: getRepositoryToken(User),
          useValue: mockUsersRepository,
        },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
    usersRepository = module.get<Repository<User>>(getRepositoryToken(User));
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    it('should create and save a user', async () => {
      const dto: CreateUserDto = { name: 'Test User' } as CreateUserDto;
      const result = await service.create(dto);
      expect(usersRepository.create).toHaveBeenCalledWith(dto);
      expect(usersRepository.save).toHaveBeenCalledWith({ ...dto, id: 1 });
      expect(result).toEqual(mockUser);
    });
  });

  describe('findAll', () => {
    it('should log and return all users string', () => {
      const logSpy = jest.spyOn<any, any>(service['logger'], 'log');
      const result = service.findAll();
      expect(logSpy).toHaveBeenCalledWith('Retrieving all users');
      expect(result).toBe('This action returns all users');
    });
  });

  describe('findOne', () => {
    it('should return a user string by id', () => {
      expect(service.findOne(2)).toBe('This action returns a #2 user');
    });
  });

  describe('update', () => {
    it('should return an update string by id', () => {
      const dto: UpdateUserDto = { name: 'Updated' } as UpdateUserDto;
      expect(service.update(3, dto)).toBe('This action updates a #3 user');
    });
  });

  describe('remove', () => {
    it('should return a remove string by id', () => {
      expect(service.remove(4)).toBe('This action removes a #4 user');
    });
  });
});
