import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from './auth.service';
import { JwtService } from '@nestjs/jwt';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { UserAlreadyExists } from '@common/exceptions/user-already-exists.exception';
import { InvalidCredentialsException } from '@common/exceptions/invalid-credentials.exception';
import { CreateUserDto } from '@users/dto/create-user.dto';
import { LoginDto } from '@auth/dto/login.dto';
import { UsersService } from '@users/users.service';
import { UserResponseDto } from '@users/dto/user-response.dto';
import { ERROR_MESSAGES } from '@common/constants/error-messages.constants';


describe('AuthService', () => {
  let service: AuthService;
  let usersService: UsersService;

  const mockUser = { id: 1, email: 'test@example.com', password: 'hashed' };
  const mockUsersService = {
    findUserByEmail: jest.fn(),
    createUser: jest.fn(),
    validatePassword: jest.fn(),
  };
  const mockJwtService = {
    sign: jest.fn().mockReturnValue('token'),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: mockUsersService },
        { provide: JwtService, useValue: mockJwtService },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    usersService = module.get<UsersService>(UsersService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('registerUser', () => {
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

  describe('loginUser', () => {
    it('should throw BadRequestException if email or password is missing', async () => {
      await expect(service.loginUser({ email: '', password: '' } as LoginDto)).rejects.toThrow(BadRequestException);
      await expect(service.loginUser({ email: 'test@example.com' } as LoginDto)).rejects.toThrow(BadRequestException);
      await expect(service.loginUser({ password: 'pass' } as LoginDto)).rejects.toThrow(BadRequestException);
    });

    it('should throw InvalidCredentialsException if user not found', async () => {
      const dto: LoginDto = { email: 'notfound@example.com', password: 'pass' };
      mockUsersService.findUserByEmail.mockResolvedValueOnce(null);

      await expect(service.loginUser(dto)).rejects.toThrow(InvalidCredentialsException);
    });

    it('should throw InvalidCredentialsException if password is invalid', async () => {
      const dto: LoginDto = { email: 'test@example.com', password: 'wrong' };
      mockUsersService.findUserByEmail.mockResolvedValueOnce(mockUser);
      mockUsersService.validatePassword.mockResolvedValueOnce(false);

      await expect(service.loginUser(dto)).rejects.toThrow(InvalidCredentialsException);
    });

    it('should log and return tokens if credentials are valid', async () => {
      const dto: LoginDto = { email: 'test@example.com', password: 'pass' };
      mockUsersService.findUserByEmail.mockResolvedValueOnce(mockUser);
      mockUsersService.validatePassword.mockResolvedValueOnce(true);
      const loggerSpy = jest.spyOn(service['logger'], 'log');

      await service.loginUser(dto);

      expect(loggerSpy).toHaveBeenCalledWith(`Logging in User with email ${dto.email}`);
      expect(loggerSpy).toHaveBeenCalledWith(`Generating tokens for user with email ${dto.email}`);
    });
  });
});