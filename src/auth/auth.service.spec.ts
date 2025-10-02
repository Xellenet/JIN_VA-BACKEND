import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from './auth.service';
import { JwtService } from '@nestjs/jwt';
import { BadRequestException } from '@nestjs/common';
import { UserAlreadyExists } from '@common/exceptions/user-already-exists.exception';
import { CreateUserDto } from '@users/dto/create-user.dto';
import { UsersService } from '@users/users.service';
import { ERROR_MESSAGES } from '@common/constants/error-messages.constants';
import { UserResponseDto } from '@users/dto/user-response.dto';


describe('AuthService', () => {
  let service: AuthService;
  let usersService: UsersService;

  const mockUser = { id: 1, email: 'test@example.com', password: 'hashed' };
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
    await expect(service.registerUser({ password: 'pass' } as CreateUserDto)).rejects.toThrow(BadRequestException);
  });

  it('should log registering user with email', async () => {
    const dto: CreateUserDto = { email: 'test@example.com', password: 'pass' } as CreateUserDto;
    const loggerSpy = jest.spyOn(service['logger'], 'log');
    mockUsersService.findUserByEmail.mockResolvedValueOnce(undefined);
    mockUsersService.createUser.mockResolvedValueOnce(mockUser);

    await service.registerUser(dto);

    expect(loggerSpy).toHaveBeenCalledWith(`Registering User with email ${dto.email}`);
    expect(loggerSpy).toHaveBeenCalledWith(`User registered with email ${mockUser.email}`);
  });

  it('should throw UserAlreadyExists if user already exists', async () => {
    const dto: CreateUserDto = { email: 'test@example.com', password: 'pass' } as CreateUserDto;
    mockUsersService.findUserByEmail.mockResolvedValueOnce(mockUser);

    await expect(service.registerUser(dto)).rejects.toThrow(UserAlreadyExists);
    expect(mockUsersService.findUserByEmail).toHaveBeenCalledWith(dto.email);
  });

  it('should create and return user if not exists', async () => {
    const dto: CreateUserDto = { email: 'new@example.com', password: 'pass' } as CreateUserDto;
    mockUsersService.findUserByEmail.mockResolvedValueOnce(undefined);
    mockUsersService.createUser.mockResolvedValueOnce(mockUser);

    const result = await service.registerUser(dto);

    expect(mockUsersService.findUserByEmail).toHaveBeenCalledWith(dto.email);
    expect(mockUsersService.createUser).toHaveBeenCalledWith(dto);
    expect(result).toBeInstanceOf(UserResponseDto);
    expect(result.email).toEqual(mockUser.email);
  });
});