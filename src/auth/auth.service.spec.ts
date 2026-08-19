import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from './auth.service';
import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { UserAlreadyExists } from '@common/exceptions/user-already-exists.exception';
import { InvalidCredentialsException } from '@common/exceptions/invalid-credentials.exceptions';
import { SocialOnlyAccountException } from '@common/exceptions/social-only-account.exception';
import { CreateUserDto } from '@users/dto/create-user.dto';
import { LoginDto } from './dto/login.dto';
import { UsersService } from '@users/users.service';
import { UserTokenService } from '@users/token.service';
import { UserResponseDto } from '@users/dto/user-response.dto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SocialAuthStrategyFactory } from './social-auth.factory';
import { OAuthStateService } from './oauth-state.service';
import { Role } from '@common/types/enums';
import { OAuthCallbackDto } from './dto/oauth-callback.dto';

describe('AuthService', () => {
  let service: AuthService;

  const mockUser = {
    id: 1,
    email: 'test@example.com',
    password: 'hashed',
    firstname: 'Test',
    role: Role.CUSTOMER,
    accountVerified: true,
    verificationToken: 'token',
  };
  const mockUsersService = {
    findUserByEmail: jest.fn(),
    createUser: jest.fn(),
    validatePassword: jest.fn(),
    hasUsablePassword: jest.fn(),
    getPasswordCheckResult: jest.fn(),
    updateUserData: jest.fn(),
  };
  const mockUserTokenService = {
    createToken: jest.fn(),
    createJWTTokens: jest.fn(),
    consumeRefreshToken: jest.fn(),
    validateToken: jest.fn(),
    revokeToken: jest.fn(),
    revokeRefreshTokenForUser: jest.fn(),
    getRecentToken: jest.fn(),
    getValidPasswordResetToken: jest.fn(),
  };
  const mockEmitter = {
    emit: jest.fn(),
  };
  const mockSocialAuthStrategyFactory = {
    getStrategy: jest.fn(),
  };
  const mockOAuthStateService = {
    generateState: jest.fn(),
    consumeState: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: mockUsersService },
        { provide: UserTokenService, useValue: mockUserTokenService },
        { provide: EventEmitter2, useValue: mockEmitter },
        {
          provide: SocialAuthStrategyFactory,
          useValue: mockSocialAuthStrategyFactory,
        },
        { provide: OAuthStateService, useValue: mockOAuthStateService },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    jest.clearAllMocks();
    // Default to "has a usable password, not yet validated" so existing
    // loginUser tests (written before G10) don't need to know about the new
    // social-only-account check.
    mockUsersService.hasUsablePassword.mockResolvedValue(true);
    mockUsersService.getPasswordCheckResult.mockResolvedValue({
      hasPassword: true,
      isValid: true,
    });
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('registerUser', () => {
    it('should throw BadRequestException if email is missing', async () => {
      await expect(
        service.registerUser({ password: 'pass' } as CreateUserDto),
      ).rejects.toThrow(BadRequestException);
    });

    it('should default role to CUSTOMER when omitted and log registering user with email', async () => {
      const dto: CreateUserDto = {
        email: 'test@example.com',
        password: 'pass',
      } as CreateUserDto;
      const loggerSpy = jest.spyOn(service['logger'], 'log');
      mockUsersService.findUserByEmail.mockResolvedValueOnce(undefined);
      mockUsersService.createUser.mockResolvedValueOnce({ data: mockUser });
      mockUserTokenService.createToken.mockResolvedValueOnce({
        token: 'verification-token',
      });

      await service.registerUser(dto);

      expect(dto.role).toEqual(Role.CUSTOMER);
      expect(loggerSpy).toHaveBeenCalledWith(
        `Registering User with email ${dto.email}`,
      );
      expect(loggerSpy).toHaveBeenCalledWith(
        `User registered with email ${mockUser.email}`,
      );
    });

    it('should reject role: ADMIN on self-registration (S3)', async () => {
      const dto: CreateUserDto = {
        email: 'admin@example.com',
        password: 'pass',
        role: Role.ADMIN,
      } as CreateUserDto;
      await expect(service.registerUser(dto)).rejects.toThrow(
        BadRequestException,
      );
      expect(mockUsersService.findUserByEmail).not.toHaveBeenCalled();
    });

    it('should throw UserAlreadyExists if user already exists', async () => {
      const dto: CreateUserDto = {
        email: 'test@example.com',
        password: 'pass',
      } as CreateUserDto;
      mockUsersService.findUserByEmail.mockResolvedValueOnce(mockUser);

      await expect(service.registerUser(dto)).rejects.toThrow(
        UserAlreadyExists,
      );
      expect(mockUsersService.findUserByEmail).toHaveBeenCalledWith(dto.email);
    });

    it('should create, emit event, and return user if not exists', async () => {
      const dto: CreateUserDto = {
        email: 'new@example.com',
        password: 'pass',
        role: Role.CUSTOMER,
      } as CreateUserDto;
      mockUsersService.findUserByEmail.mockResolvedValueOnce(undefined);
      mockUsersService.createUser.mockResolvedValueOnce({ data: mockUser });
      mockUserTokenService.createToken.mockResolvedValueOnce({
        token: 'verification-token',
      });

      const result = await service.registerUser(dto);

      expect(mockUsersService.findUserByEmail).toHaveBeenCalledWith(dto.email);
      expect(mockUsersService.createUser).toHaveBeenCalledWith(dto);
      expect(mockEmitter.emit).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          email: mockUser.email,
          firstname: mockUser.firstname,
        }),
      );
      expect(result).toBeInstanceOf(UserResponseDto);
      expect(result.email).toEqual(mockUser.email);
    });
  });

  describe('loginUser', () => {
    it('should throw BadRequestException if email or password is missing', async () => {
      await expect(
        service.loginUser({ email: '', password: '' } as LoginDto),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.loginUser({ email: 'test@example.com' } as LoginDto),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.loginUser({ password: 'pass' } as LoginDto),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw InvalidCredentialsException if user not found', async () => {
      const dto: LoginDto = { email: 'notfound@example.com', password: 'pass' };
      mockUsersService.findUserByEmail.mockResolvedValueOnce(null);

      await expect(service.loginUser(dto)).rejects.toThrow(
        InvalidCredentialsException,
      );
    });

    it('should throw InvalidCredentialsException if password is invalid', async () => {
      const dto: LoginDto = { email: 'test@example.com', password: 'wrong' };
      mockUsersService.findUserByEmail.mockResolvedValueOnce(mockUser);
      mockUsersService.getPasswordCheckResult.mockResolvedValueOnce({
        hasPassword: true,
        isValid: false,
      });

      await expect(service.loginUser(dto)).rejects.toThrow(
        InvalidCredentialsException,
      );
    });

    it('should throw ForbiddenException if the account is not verified (S4)', async () => {
      const dto: LoginDto = {
        email: 'unverified@example.com',
        password: 'pass',
      };
      mockUsersService.findUserByEmail.mockResolvedValueOnce({
        ...mockUser,
        accountVerified: false,
      });
      mockUsersService.getPasswordCheckResult.mockResolvedValueOnce({
        hasPassword: true,
        isValid: true,
      });

      await expect(service.loginUser(dto)).rejects.toThrow(ForbiddenException);
    });

    it('should log and return { result, refreshToken } if credentials are valid, with no refresh token on result (S1)', async () => {
      const dto: LoginDto = { email: 'test@example.com', password: 'pass' };
      mockUsersService.findUserByEmail.mockResolvedValueOnce(mockUser);
      mockUsersService.getPasswordCheckResult.mockResolvedValueOnce({
        hasPassword: true,
        isValid: true,
      });
      mockUserTokenService.createJWTTokens.mockResolvedValueOnce({
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_at: new Date(),
      });
      const loggerSpy = jest.spyOn(service['logger'], 'log');

      const { result, refreshToken } = await service.loginUser(dto);

      expect(loggerSpy).toHaveBeenCalledWith(
        `Logging in User with email ${dto.email}`,
      );
      expect(result).toHaveProperty('access_token', 'access-token');
      expect(result).not.toHaveProperty('refresh_token');
      expect(refreshToken).toEqual('refresh-token');
    });

    it('should throw SocialOnlyAccountException before ever calling bcrypt.compare, for a Google-only account (G10)', async () => {
      const dto: LoginDto = { email: 'social@example.com', password: 'pass' };
      mockUsersService.findUserByEmail.mockResolvedValueOnce({
        ...mockUser,
        email: dto.email,
        password: null,
      });
      mockUsersService.getPasswordCheckResult.mockResolvedValueOnce({
        hasPassword: false,
        isValid: false,
      });

      await expect(service.loginUser(dto)).rejects.toThrow(
        SocialOnlyAccountException,
      );
      // G10 efficiency fix: loginUser() now does a single combined check
      // (getPasswordCheckResult) instead of separate
      // hasUsablePassword()/validatePassword() calls, so there's no second
      // call left to assert was skipped — the combined result itself
      // (hasPassword: false) is what proves bcrypt.compare was never reached
      // (see UsersService.getPasswordCheckResult's own null-password guard).
      expect(mockUsersService.validatePassword).not.toHaveBeenCalled();
      expect(mockUsersService.hasUsablePassword).not.toHaveBeenCalled();
    });
  });

  describe('refreshTokens (S5)', () => {
    it('should throw BadRequestException when the refresh token cannot be consumed (unknown/already-rotated/expired)', async () => {
      mockUserTokenService.consumeRefreshToken.mockResolvedValueOnce(null);

      await expect(service.refreshTokens('stale-token')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should issue a new pair via consumeRefreshToken and never include refresh_token on the result', async () => {
      mockUserTokenService.consumeRefreshToken.mockResolvedValueOnce(mockUser);
      mockUserTokenService.createJWTTokens.mockResolvedValueOnce({
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        expires_at: new Date(),
      });

      const { result, refreshToken } =
        await service.refreshTokens('valid-token');

      expect(mockUserTokenService.consumeRefreshToken).toHaveBeenCalledWith(
        'valid-token',
      );
      expect(result).toHaveProperty('access_token', 'new-access-token');
      expect(result).not.toHaveProperty('refresh_token');
      expect(refreshToken).toEqual('new-refresh-token');
    });
  });

  describe('initiateOAuthFlow (G9)', () => {
    const mockStrategy = { getAuthorizationUrl: jest.fn() };

    beforeEach(() => {
      mockSocialAuthStrategyFactory.getStrategy.mockReturnValue(mockStrategy);
      mockOAuthStateService.generateState.mockReturnValue('state-123');
      mockStrategy.getAuthorizationUrl.mockReturnValue(
        'https://accounts.google.com/authorize?...',
      );
    });

    it('normalizes `artisan` and embeds it in the generated state', async () => {
      const url = await service.initiateOAuthFlow('google', 'artisan');

      expect(mockOAuthStateService.generateState).toHaveBeenCalledWith(
        'google',
        Role.ARTISAN,
      );
      expect(url).toEqual('https://accounts.google.com/authorize?...');
    });

    it.each([undefined, '', 'admin', 'not-a-role'])(
      'defaults role %p to CUSTOMER — never ADMIN',
      async (role) => {
        await service.initiateOAuthFlow('google', role);

        expect(mockOAuthStateService.generateState).toHaveBeenCalledWith(
          'google',
          Role.CUSTOMER,
        );
      },
    );
  });

  describe('handleOAuthCallback', () => {
    const mockStrategy = {
      getAccessToken: jest.fn(),
      getUserProfile: jest.fn(),
    };

    beforeEach(() => {
      mockSocialAuthStrategyFactory.getStrategy.mockReturnValue(mockStrategy);
      mockUserTokenService.createJWTTokens.mockResolvedValue({
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_at: new Date(),
      });
    });

    it('throws UnauthorizedException when the provider reports an error (denied/cancelled consent)', async () => {
      await expect(
        service.handleOAuthCallback('google', {
          error: 'access_denied',
          error_description: 'user cancelled',
        } as OAuthCallbackDto),
      ).rejects.toThrow(UnauthorizedException);
      expect(mockOAuthStateService.consumeState).not.toHaveBeenCalled();
    });

    it('throws UnauthorizedException for an invalid/expired/already-consumed state', async () => {
      mockOAuthStateService.consumeState.mockReturnValueOnce(null);

      await expect(
        service.handleOAuthCallback('google', {
          code: 'auth-code',
          state: 'bad-state',
        } as OAuthCallbackDto),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('throws BadRequestException when the authorization code is missing', async () => {
      mockOAuthStateService.consumeState.mockReturnValueOnce({
        role: Role.CUSTOMER,
      });

      await expect(
        service.handleOAuthCallback('google', {
          state: 'state-123',
        } as OAuthCallbackDto),
      ).rejects.toThrow(BadRequestException);
    });

    it('logs into the existing account and ignores the role param entirely (G6)', async () => {
      mockOAuthStateService.consumeState.mockReturnValueOnce({
        role: Role.ARTISAN,
      });
      mockStrategy.getAccessToken.mockResolvedValueOnce(
        'provider-access-token',
      );
      mockStrategy.getUserProfile.mockResolvedValueOnce({
        email: mockUser.email,
        firstname: 'Test',
        lastname: 'User',
        provider: 'google',
        providerId: 'google-id-1',
      });
      mockUsersService.findUserByEmail.mockResolvedValueOnce(mockUser);

      const { result, refreshToken } = await service.handleOAuthCallback(
        'google',
        { code: 'auth-code', state: 'state-123' } as OAuthCallbackDto,
      );

      expect(mockUsersService.createUser).not.toHaveBeenCalled();
      expect(result).not.toHaveProperty('refresh_token');
      expect(refreshToken).toEqual('refresh-token');
    });

    it('registers a brand-new account with the state-embedded role, and logs it in immediately (G3/G5/G9)', async () => {
      mockOAuthStateService.consumeState.mockReturnValueOnce({
        role: Role.ARTISAN,
      });
      mockStrategy.getAccessToken.mockResolvedValueOnce(
        'provider-access-token',
      );
      mockStrategy.getUserProfile.mockResolvedValueOnce({
        email: 'new-social@example.com',
        firstname: 'New',
        lastname: 'Signup',
        provider: 'google',
        providerId: 'google-id-2',
      });
      mockUsersService.findUserByEmail.mockResolvedValueOnce(null);
      mockUsersService.createUser.mockResolvedValueOnce({
        data: {
          ...mockUser,
          id: 2,
          email: 'new-social@example.com',
          role: Role.ARTISAN,
          password: null,
        },
      });

      const { result, refreshToken } = await service.handleOAuthCallback(
        'google',
        { code: 'auth-code', state: 'state-123' } as OAuthCallbackDto,
      );

      expect(mockUsersService.createUser).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'new-social@example.com',
          role: Role.ARTISAN,
        }),
      );
      // G3: same AuthTokenResult shape as loginUser — no refresh token in the body.
      expect(result).not.toHaveProperty('refresh_token');
      expect(refreshToken).toEqual('refresh-token');
    });

    it('never creates an ADMIN account, even if the state somehow carried one (defense in depth, G9)', async () => {
      mockOAuthStateService.consumeState.mockReturnValueOnce({
        role: Role.ADMIN,
      });
      mockStrategy.getAccessToken.mockResolvedValueOnce(
        'provider-access-token',
      );
      mockStrategy.getUserProfile.mockResolvedValueOnce({
        email: 'sneaky@example.com',
        firstname: 'Sneaky',
        lastname: 'Signup',
        provider: 'google',
        providerId: 'google-id-3',
      });
      mockUsersService.findUserByEmail.mockResolvedValueOnce(null);
      mockUsersService.createUser.mockResolvedValueOnce({
        data: { ...mockUser, id: 3, email: 'sneaky@example.com' },
      });

      await service.handleOAuthCallback('google', {
        code: 'auth-code',
        state: 'state-123',
      } as OAuthCallbackDto);

      expect(mockUsersService.createUser).toHaveBeenCalledWith(
        expect.objectContaining({ role: Role.CUSTOMER }),
      );
    });
  });
});
