import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from './auth.service';
import { UsersService } from 'src/users/users.service';
import { JwtService } from '@nestjs/jwt';
import { BadRequestException } from '@nestjs/common';
import { UserAlreadyExists } from 'src/common/exceptions/user-already-exists.exception';
import { ERROR_MESSAGES } from 'src/common/constants/error-messages.constants';
import { CreateUserDto } from 'src/users/dto/create-user.dto';

describe('AuthService', () => {
  let service: AuthService;
  let usersService: UsersService;

  const mockUser = { id: 1, email: 'test@example.com' };
  const mockUsersService = {
    findUserByEmail: jest.fn(),
    createUser: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: mockUsersService },
        { provide: JwtService, useValue: {} },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    usersService = module.get<UsersService>(UsersService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should throw BadRequestException if email is missing', async () => {
    await expect(service.registerUser({} as CreateUserDto)).rejects.toThrow(BadRequestException);
  });

  it('should throw UserAlreadyExists if user already exists', async () => {
    const dto: CreateUserDto = { email: 'test@example.com' } as CreateUserDto;
    mockUsersService.findUserByEmail.mockResolvedValueOnce(mockUser);

    await expect(service.registerUser(dto)).rejects.toThrow(UserAlreadyExists);
    expect(mockUsersService.findUserByEmail).toHaveBeenCalledWith(dto.email);
  });

  it('should create and return user if not exists', async () => {
    const dto: CreateUserDto = { email: 'new@example.com' } as CreateUserDto;
    mockUsersService.findUserByEmail.mockResolvedValueOnce(undefined);
    mockUsersService.createUser.mockResolvedValueOnce(mockUser);

    const result = await service.registerUser(dto);

    expect(mockUsersService.findUserByEmail).toHaveBeenCalledWith(dto.email);
    expect(mockUsersService.createUser).toHaveBeenCalledWith(dto);