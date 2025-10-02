import { Test, TestingModule } from '@nestjs/testing';
import { UsersService } from './users.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { User } from './entities/user.entity';
import { Repository } from 'typeorm';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { UserAlreadyExists } from '@common/exceptions/user-already-exists.exception';

describe('UsersService', () => {
  let service: UsersService;
  let usersRepository: jest.Mocked<Repository<User>>;

  const mockUser = { id: 1, email: 'test@example.com', password: 'hashed' } as User;

  const mockUsersRepository = {
    create: jest.fn(),
    save: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
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
    usersRepository = module.get(getRepositoryToken(User));
    jest.clearAllMocks();
  });

  describe('createUser', () => {
    it('should throw BadRequestException if email is missing', async () => {
      await expect(service.createUser({ password: 'pass' } as CreateUserDto)).rejects.toThrow(BadRequestException);
    });

    it('should throw UserAlreadyExists if user already exists', async () => {
      mockUsersRepository.findOne.mockResolvedValueOnce(mockUser);
      const dto: CreateUserDto = { email: mockUser.email, password: 'pass' } as CreateUserDto;
      await expect(service.createUser(dto)).rejects.toThrow(UserAlreadyExists);
    });

    it('should create and save a user, and log the action', async () => {
      const dto: CreateUserDto = { email: 'new@example.com', password: 'pass' } as CreateUserDto;
      mockUsersRepository.findOne.mockResolvedValueOnce(null);
      mockUsersRepository.create.mockReturnValueOnce({ ...dto, id: 2 });
      mockUsersRepository.save.mockResolvedValueOnce({ ...dto, id: 2 });
      const loggerSpy = jest.spyOn(service['logger'], 'log');

      const result = await service.createUser(dto);

      expect(usersRepository.create).toHaveBeenCalledWith({
        ...dto,
        password: expect.any(String),
      });
      expect(loggerSpy).toHaveBeenCalledWith('Created user with id: 2');
      expect(usersRepository.save).toHaveBeenCalledWith({ ...dto, id: 2 });
      expect(result).toEqual({ ...dto, id: 2 });
    });
  });

  describe('findUser', () => {
    it('should log and return all users', async () => {
      const users = [mockUser];
      mockUsersRepository.find.mockResolvedValueOnce(users);
      const loggerSpy = jest.spyOn(service['logger'], 'log');

      const result = await service.findUser();

      expect(loggerSpy).toHaveBeenCalledWith('Retrieving all users');
      expect(usersRepository.find).toHaveBeenCalled();
      expect(result).toEqual(users);
    });
  });

  describe('findUserByEmail', () => {
    it('should throw NotFoundException if email is missing', async () => {
      await expect(service.findUserByEmail(undefined as any)).rejects.toThrow(NotFoundException);
    });

    it('should log and return user if found', async () => {
      mockUsersRepository.findOne.mockResolvedValueOnce(mockUser);
      const loggerSpy = jest.spyOn(service['logger'], 'log');
      const result = await service.findUserByEmail(mockUser.email);

      expect(loggerSpy).toHaveBeenCalledWith(`Finding user with email ${mockUser.email}`);
      expect(usersRepository.findOne).toHaveBeenCalledWith({ where: { email: mockUser.email } });
      expect(result).toEqual(mockUser);
    });

    it('should return null if user not found', async () => {
      mockUsersRepository.findOne.mockResolvedValueOnce(null);
      const result = await service.findUserByEmail('notfound@example.com');
      expect(result).toBeNull();
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
