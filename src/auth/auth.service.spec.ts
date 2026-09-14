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
import { AccountPendingDeletionException } from '@common/exceptions/account-pending-deletion.exception';
import { VARIABLES } from '@common/constants/variables.constants';
import { ERROR_MESSAGES } from '@common/constants/error-messages.constants';
import { MailEvent } from 'mail/events/mail.events';
import { addDays, subDays } from 'date-fns';
import { plainToInstance } from 'class-transformer';
import { hashEmailForLog } from '@common/utils/log-identifier.util';

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
    findUserById: jest.fn(),
    isEmailRegistered: jest.fn(),
    createUser: jest.fn(),
    validatePassword: jest.fn(),
    hasUsablePassword: jest.fn(),
    getPasswordCheckResult: jest.fn(),
    updateUserData: jest.fn(),
    findSoftDeletedUserByEmail: jest.fn(),
    getSoftDeletedPasswordCheckResult: jest.fn(),
    spendPasswordCheckCost: jest.fn(),
    restoreAccountById: jest.fn(),
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
    // C1.4: default to "there is no soft-deleted account for this email", so
    // tests written before the recovery window don't need to know about it.
    mockUsersService.findSoftDeletedUserByEmail.mockResolvedValue(null);
    mockUsersService.getSoftDeletedPasswordCheckResult.mockResolvedValue({
      hasPassword: false,
      isValid: false,
    });
    // C1.6: registration's existence check spans soft-deleted rows; default to
    // "address is free".
    mockUsersService.isEmailRegistered.mockResolvedValue(false);
    mockUsersService.spendPasswordCheckCost.mockResolvedValue(undefined);
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
      mockUsersService.isEmailRegistered.mockResolvedValueOnce(false);
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
      expect(mockUsersService.isEmailRegistered).not.toHaveBeenCalled();
    });

    it('should throw UserAlreadyExists if user already exists', async () => {
      const dto: CreateUserDto = {
        email: 'test@example.com',
        password: 'pass',
      } as CreateUserDto;
      mockUsersService.isEmailRegistered.mockResolvedValueOnce(true);

      await expect(service.registerUser(dto)).rejects.toThrow(
        UserAlreadyExists,
      );
      expect(mockUsersService.isEmailRegistered).toHaveBeenCalledWith(
        dto.email,
      );
    });

    /**
     * C1.6: the existence check must span soft-deleted rows, and the rejection
     * must be the *same* exception a live account produces.
     *
     * Before this, registration checked `findUserByEmail` (soft-delete
     * filtered), so a deleted address skipped this branch entirely and was
     * rejected downstream by the `users.email` unique constraint — a 409 with
     * a different message and no `meta.error`. One unauthenticated probe then
     * classified any address as live / deleted / free. The assertion that
     * `findUserByEmail` is *not* consulted is the regression guard: swapping
     * back to it silently reopens the leak.
     */
    it('rejects a taken address through one live-or-deleted-blind check, never the soft-delete-filtered lookup', async () => {
      const dto: CreateUserDto = {
        email: 'deleted@example.com',
        password: 'pass',
      } as CreateUserDto;
      mockUsersService.isEmailRegistered.mockResolvedValueOnce(true);

      let rejection: unknown;
      try {
        await service.registerUser(dto);
      } catch (err) {
        rejection = err;
      }

      // Live and soft-deleted are the same branch now, so they cannot produce
      // different messages or a different `meta.error`.
      expect(rejection).toBeInstanceOf(UserAlreadyExists);
      expect((rejection as UserAlreadyExists).message).toBe(
        ERROR_MESSAGES.USER.EMAIL_ALREADY_EXISTS(dto.email),
      );
      expect(mockUsersService.findUserByEmail).not.toHaveBeenCalled();
      expect(mockUsersService.createUser).not.toHaveBeenCalled();
    });

    it('should create, emit event, and return user if not exists', async () => {
      const dto: CreateUserDto = {
        email: 'new@example.com',
        password: 'pass',
        role: Role.CUSTOMER,
      } as CreateUserDto;
      mockUsersService.isEmailRegistered.mockResolvedValueOnce(false);
      mockUsersService.createUser.mockResolvedValueOnce({ data: mockUser });
      mockUserTokenService.createToken.mockResolvedValueOnce({
        token: 'verification-token',
      });

      const result = await service.registerUser(dto);

      expect(mockUsersService.isEmailRegistered).toHaveBeenCalledWith(
        dto.email,
      );
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
        `Processing login request for email hash ${hashEmailForLog(dto.email)}`,
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

  /**
   * C1.4: the account-enumeration-critical branch. Every case below that has
   * not proven ownership must be indistinguishable from every other, and only
   * a caller with the correct password for a still-restorable account may
   * learn anything at all.
   */
  describe('loginUser — soft-deleted accounts (C1.4)', () => {
    const dto: LoginDto = { email: 'gone@example.com', password: 'pass' };

    beforeEach(() => {
      // No *live* account for this address — the only way into this branch.
      mockUsersService.findUserByEmail.mockResolvedValue(null);
    });

    it('offers restore, with real dates and no tokens, when the password is correct and the window is open', async () => {
      const deletedAt = subDays(new Date(), 3);
      mockUsersService.findSoftDeletedUserByEmail.mockResolvedValueOnce({
        ...mockUser,
        deletedAt,
      });
      mockUsersService.getSoftDeletedPasswordCheckResult.mockResolvedValueOnce({
        hasPassword: true,
        isValid: true,
      });

      const thrown = await service.loginUser(dto).catch((e: unknown) => e);

      expect(thrown).toBeInstanceOf(AccountPendingDeletionException);
      expect(mockUserTokenService.createJWTTokens).not.toHaveBeenCalled();

      const body = (
        thrown as AccountPendingDeletionException
      ).getResponse() as {
        errorCode: string;
        details: { deletedAt: string; restorableUntil: string };
      };
      expect(body.errorCode).toBe('ACCOUNT_PENDING_DELETION');
      expect(body.details.deletedAt).toBe(deletedAt.toISOString());
      expect(body.details.restorableUntil).toBe(
        addDays(deletedAt, VARIABLES.SOFT_DELETE_RETENTION_DAYS).toISOString(),
      );
    });

    // The ordering requirement: the password is verified before the deletion
    // state is allowed to affect the response.
    it('checks the password before revealing anything, and gives the generic error when it is wrong', async () => {
      mockUsersService.findSoftDeletedUserByEmail.mockResolvedValueOnce({
        ...mockUser,
        deletedAt: subDays(new Date(), 3),
      });
      mockUsersService.getSoftDeletedPasswordCheckResult.mockResolvedValueOnce({
        hasPassword: true,
        isValid: false,
      });

      await expect(service.loginUser(dto)).rejects.toThrow(
        InvalidCredentialsException,
      );
      expect(
        mockUsersService.getSoftDeletedPasswordCheckResult,
      ).toHaveBeenCalledWith(dto.password, mockUser.id);
    });

    // C1.7: past the window there is no prompt and no hint the account ever
    // existed — even for a caller who did prove ownership.
    it('gives the generic error for a correct password past the recovery window', async () => {
      mockUsersService.findSoftDeletedUserByEmail.mockResolvedValueOnce({
        ...mockUser,
        deletedAt: subDays(
          new Date(),
          VARIABLES.SOFT_DELETE_RETENTION_DAYS + 1,
        ),
      });
      mockUsersService.getSoftDeletedPasswordCheckResult.mockResolvedValueOnce({
        hasPassword: true,
        isValid: true,
      });

      await expect(service.loginUser(dto)).rejects.toThrow(
        InvalidCredentialsException,
      );
    });

    // A soft-deleted Google-only account must not get the "use Google
    // instead" hint: that would disclose the account's existence to someone
    // who has proven nothing.
    it('gives the generic error — not the social-only hint — for a soft-deleted Google account', async () => {
      mockUsersService.findSoftDeletedUserByEmail.mockResolvedValueOnce({
        ...mockUser,
        password: null,
        deletedAt: subDays(new Date(), 3),
      });
      mockUsersService.getSoftDeletedPasswordCheckResult.mockResolvedValueOnce({
        hasPassword: false,
        isValid: false,
      });

      const thrown = await service.loginUser(dto).catch((e: unknown) => e);
      expect(thrown).toBeInstanceOf(InvalidCredentialsException);
      expect(thrown).not.toBeInstanceOf(SocialOnlyAccountException);
    });

    it('gives the generic error for an address with no account at all', async () => {
      mockUsersService.findSoftDeletedUserByEmail.mockResolvedValueOnce(null);

      await expect(service.loginUser(dto)).rejects.toThrow(
        InvalidCredentialsException,
      );
      expect(
        mockUsersService.getSoftDeletedPasswordCheckResult,
      ).not.toHaveBeenCalled();
    });
  });

  /**
   * C1.4's enumeration requirement is about the *whole* observable response,
   * and identical bodies were only half of it: the branches that found no row
   * returned without any bcrypt work while the wrong-password branches paid
   * for a full comparison, so response time separated "registered" from
   * "never registered" — and on the restore endpoint, "has a deleted account
   * still inside its window" from everything else.
   *
   * The invariant asserted here is **exactly one** credential check per
   * attempt, real or throwaway. Two would be as distinguishable as none.
   */
  describe('credential checks cost the same on every rejection path (C1.4)', () => {
    const dto: LoginDto = { email: 'gone@example.com', password: 'pass' };

    const checksPerformed = () =>
      mockUsersService.getSoftDeletedPasswordCheckResult.mock.calls.length +
      mockUsersService.getPasswordCheckResult.mock.calls.length +
      mockUsersService.spendPasswordCheckCost.mock.calls.length;

    it('login: spends one comparison for an address with no account at all', async () => {
      mockUsersService.findUserByEmail.mockResolvedValueOnce(null);
      mockUsersService.findSoftDeletedUserByEmail.mockResolvedValueOnce(null);

      await expect(service.loginUser(dto)).rejects.toThrow(
        InvalidCredentialsException,
      );

      expect(mockUsersService.spendPasswordCheckCost).toHaveBeenCalledWith(
        dto.password,
      );
      expect(checksPerformed()).toBe(1);
    });

    it('login: spends one comparison for a wrong password on a soft-deleted account', async () => {
      mockUsersService.findUserByEmail.mockResolvedValueOnce(null);
      mockUsersService.findSoftDeletedUserByEmail.mockResolvedValueOnce({
        ...mockUser,
        deletedAt: subDays(new Date(), 3),
      });
      mockUsersService.getSoftDeletedPasswordCheckResult.mockResolvedValueOnce({
        hasPassword: true,
        isValid: false,
      });

      await expect(service.loginUser(dto)).rejects.toThrow(
        InvalidCredentialsException,
      );

      // The real comparison already cost what the throwaway one costs, so
      // this branch must NOT spend a second.
      expect(mockUsersService.spendPasswordCheckCost).not.toHaveBeenCalled();
      expect(checksPerformed()).toBe(1);
    });

    it('login: spends one comparison for a wrong password on a live account', async () => {
      mockUsersService.findUserByEmail.mockResolvedValueOnce(mockUser);
      mockUsersService.getPasswordCheckResult.mockResolvedValueOnce({
        hasPassword: true,
        isValid: false,
      });

      await expect(service.loginUser(dto)).rejects.toThrow(
        InvalidCredentialsException,
      );

      expect(checksPerformed()).toBe(1);
    });

    it('restore-account: spends one comparison when there is nothing restorable', async () => {
      mockUsersService.findSoftDeletedUserByEmail.mockResolvedValueOnce(null);

      await expect(service.restoreAccount(dto)).rejects.toThrow(
        InvalidCredentialsException,
      );

      expect(mockUsersService.spendPasswordCheckCost).toHaveBeenCalledWith(
        dto.password,
      );
      expect(checksPerformed()).toBe(1);
      expect(mockUsersService.restoreAccountById).not.toHaveBeenCalled();
    });

    it('restore-account: spends one comparison for a wrong password', async () => {
      mockUsersService.findSoftDeletedUserByEmail.mockResolvedValueOnce({
        ...mockUser,
        deletedAt: subDays(new Date(), 3),
      });
      mockUsersService.getSoftDeletedPasswordCheckResult.mockResolvedValueOnce({
        hasPassword: true,
        isValid: false,
      });

      await expect(service.restoreAccount(dto)).rejects.toThrow(
        InvalidCredentialsException,
      );

      expect(mockUsersService.spendPasswordCheckCost).not.toHaveBeenCalled();
      expect(checksPerformed()).toBe(1);
    });
  });

  describe('restoreAccount (C1.4)', () => {
    const dto = { email: 'gone@example.com', password: 'pass' };

    it('restores and signs in a verified account, and emails a confirmation', async () => {
      mockUsersService.findSoftDeletedUserByEmail.mockResolvedValueOnce({
        ...mockUser,
        deletedAt: subDays(new Date(), 3),
      });
      mockUsersService.getSoftDeletedPasswordCheckResult.mockResolvedValueOnce({
        hasPassword: true,
        isValid: true,
      });
      mockUsersService.restoreAccountById.mockResolvedValueOnce({
        ...mockUser,
        accountVerified: true,
      });
      mockUserTokenService.createJWTTokens.mockResolvedValueOnce({
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_at: new Date(),
      });

      const { result, refreshToken } = await service.restoreAccount(dto);

      expect(result.restored).toBe(true);
      expect(result.requiresEmailVerification).toBe(false);
      expect(result.access_token).toBe('access-token');
      expect(refreshToken).toBe('refresh-token');
      expect(mockEmitter.emit).toHaveBeenCalledWith(
        MailEvent.ACCOUNT_RESTORED,
        expect.objectContaining({ email: mockUser.email }),
      );
    });

    // Restore takes precedence over the verification gate: the account comes
    // back, but no session is issued until the email is verified.
    it('restores an unverified account without issuing a session', async () => {
      mockUsersService.findSoftDeletedUserByEmail.mockResolvedValueOnce({
        ...mockUser,
        deletedAt: subDays(new Date(), 3),
      });
      mockUsersService.getSoftDeletedPasswordCheckResult.mockResolvedValueOnce({
        hasPassword: true,
        isValid: true,
      });
      mockUsersService.restoreAccountById.mockResolvedValueOnce({
        ...mockUser,
        accountVerified: false,
      });

      const { result, refreshToken } = await service.restoreAccount(dto);

      expect(result.restored).toBe(true);
      expect(result.requiresEmailVerification).toBe(true);
      expect(result.access_token).toBeUndefined();
      expect(refreshToken).toBeUndefined();
      expect(mockUserTokenService.createJWTTokens).not.toHaveBeenCalled();
    });

    it('never restores without a verified password', async () => {
      mockUsersService.findSoftDeletedUserByEmail.mockResolvedValueOnce({
        ...mockUser,
        deletedAt: subDays(new Date(), 3),
      });
      mockUsersService.getSoftDeletedPasswordCheckResult.mockResolvedValueOnce({
        hasPassword: true,
        isValid: false,
      });

      await expect(service.restoreAccount(dto)).rejects.toThrow(
        InvalidCredentialsException,
      );
      expect(mockUsersService.restoreAccountById).not.toHaveBeenCalled();
    });

    it('gives the same generic error when there is no restorable account', async () => {
      mockUsersService.findSoftDeletedUserByEmail.mockResolvedValueOnce(null);

      await expect(service.restoreAccount(dto)).rejects.toThrow(
        InvalidCredentialsException,
      );
      expect(
        mockUsersService.getSoftDeletedPasswordCheckResult,
      ).not.toHaveBeenCalled();
      expect(mockUsersService.restoreAccountById).not.toHaveBeenCalled();
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

    // C1.4: a Google-only account has no password, so the OAuth completion is
    // its ownership proof and the callback restores it inline. Without this,
    // registration would be attempted against an email a soft-deleted row
    // still holds under a unique constraint, and the owner's sign-in would
    // fail on a constraint violation instead of returning their account.
    it('restores a soft-deleted account when its owner completes the Google flow (C1.4)', async () => {
      mockOAuthStateService.consumeState.mockReturnValueOnce({
        role: Role.CUSTOMER,
      });
      mockStrategy.getAccessToken.mockResolvedValueOnce('provider-token');
      mockStrategy.getUserProfile.mockResolvedValueOnce({
        email: 'social-gone@example.com',
        firstname: 'Ama',
        lastname: 'Owusu',
        provider: 'google',
        providerId: 'google-id-4',
      });
      mockUsersService.findUserByEmail.mockResolvedValueOnce(null);
      mockUsersService.findSoftDeletedUserByEmail.mockResolvedValueOnce({
        ...mockUser,
        id: 8,
        email: 'social-gone@example.com',
        password: null,
        isSocialLogin: true,
        deletedAt: subDays(new Date(), 5),
      });
      mockUsersService.restoreAccountById.mockResolvedValueOnce({
        ...mockUser,
        id: 8,
        email: 'social-gone@example.com',
        password: null,
        isSocialLogin: true,
      });

      const { refreshToken } = await service.handleOAuthCallback('google', {
        code: 'auth-code',
        state: 'state-123',
      } as OAuthCallbackDto);

      expect(mockUsersService.restoreAccountById).toHaveBeenCalledWith(8);
      // No duplicate account, and the user lands logged in.
      expect(mockUsersService.createUser).not.toHaveBeenCalled();
      expect(refreshToken).toBe('refresh-token');
      expect(mockEmitter.emit).toHaveBeenCalledWith(
        MailEvent.ACCOUNT_RESTORED,
        expect.objectContaining({ email: 'social-gone@example.com' }),
      );
    });

    /**
     * Item 6 (security `L1`): completing the Google flow proves control of the
     * *mailbox*. That is the right ownership proof for an account whose only
     * credential ever was the Google identity, and the wrong one for an
     * account that had a password — so a password-only soft-deleted account
     * must not come back this way. The scenario it matters for is someone who
     * deleted their account *because* their Google session was compromised.
     */
    it('refuses to restore a password-only soft-deleted account (L1)', async () => {
      mockOAuthStateService.consumeState.mockReturnValueOnce({
        role: Role.CUSTOMER,
      });
      mockStrategy.getAccessToken.mockResolvedValueOnce('provider-token');
      mockStrategy.getUserProfile.mockResolvedValueOnce({
        email: 'password-only-gone@example.com',
        firstname: 'Kofi',
        lastname: 'Mensah',
        provider: 'google',
        providerId: 'google-id-5',
      });
      mockUsersService.findUserByEmail.mockResolvedValueOnce(null);
      mockUsersService.findSoftDeletedUserByEmail.mockResolvedValueOnce({
        ...mockUser,
        id: 11,
        email: 'password-only-gone@example.com',
        password: 'hashed',
        isSocialLogin: false,
        deletedAt: subDays(new Date(), 5),
      });

      await expect(
        service.handleOAuthCallback('google', {
          code: 'auth-code',
          state: 'state-123',
        } as OAuthCallbackDto),
      ).rejects.toThrow(UnauthorizedException);

      // Nothing restored, no session issued, and — the bit that would be worse
      // than a missing feature — no second row inserted for an address a
      // soft-deleted row still holds under a unique constraint.
      expect(mockUsersService.restoreAccountById).not.toHaveBeenCalled();
      expect(mockUsersService.createUser).not.toHaveBeenCalled();
      expect(mockUserTokenService.createJWTTokens).not.toHaveBeenCalled();
      expect(mockEmitter.emit).not.toHaveBeenCalledWith(
        MailEvent.ACCOUNT_RESTORED,
        expect.anything(),
      );
    });

    /**
     * The permission boundary in the other direction: this must not become a
     * way to block a genuine social user's restore. A Google account that has
     * since added a password is still a social-login account.
     */
    it('still restores a social-login account that has since set a password', async () => {
      mockOAuthStateService.consumeState.mockReturnValueOnce({
        role: Role.CUSTOMER,
      });
      mockStrategy.getAccessToken.mockResolvedValueOnce('provider-token');
      mockStrategy.getUserProfile.mockResolvedValueOnce({
        email: 'social-with-password@example.com',
        firstname: 'Adwoa',
        lastname: 'Boateng',
        provider: 'google',
        providerId: 'google-id-6',
      });
      mockUsersService.findUserByEmail.mockResolvedValueOnce(null);
      mockUsersService.findSoftDeletedUserByEmail.mockResolvedValueOnce({
        ...mockUser,
        id: 12,
        email: 'social-with-password@example.com',
        password: 'hashed',
        isSocialLogin: true,
        deletedAt: subDays(new Date(), 5),
      });
      mockUsersService.restoreAccountById.mockResolvedValueOnce({
        ...mockUser,
        id: 12,
        email: 'social-with-password@example.com',
        isSocialLogin: true,
      });

      const { refreshToken } = await service.handleOAuthCallback('google', {
        code: 'auth-code',
        state: 'state-123',
      } as OAuthCallbackDto);

      expect(mockUsersService.restoreAccountById).toHaveBeenCalledWith(12);
      expect(refreshToken).toBe('refresh-token');
    });

    /**
     * The fix touches the **restore** path only: a live password-only account
     * signing in with Google still resolves to that account (G6) and signs in.
     */
    it('leaves a live password-only account signing in with Google unchanged', async () => {
      mockOAuthStateService.consumeState.mockReturnValueOnce({
        role: Role.CUSTOMER,
      });
      mockStrategy.getAccessToken.mockResolvedValueOnce('provider-token');
      mockStrategy.getUserProfile.mockResolvedValueOnce({
        email: 'live-password@example.com',
        firstname: 'Yaw',
        lastname: 'Asare',
        provider: 'google',
        providerId: 'google-id-7',
      });
      mockUsersService.findUserByEmail.mockResolvedValueOnce({
        ...mockUser,
        id: 13,
        email: 'live-password@example.com',
        password: 'hashed',
        isSocialLogin: false,
        profilePicture: null,
      });

      const { refreshToken } = await service.handleOAuthCallback('google', {
        code: 'auth-code',
        state: 'state-123',
      } as OAuthCallbackDto);

      expect(refreshToken).toBe('refresh-token');
      expect(
        mockUsersService.findSoftDeletedUserByEmail,
      ).not.toHaveBeenCalled();
      expect(mockUsersService.restoreAccountById).not.toHaveBeenCalled();
      expect(mockUsersService.createUser).not.toHaveBeenCalled();
    });
  });

  /**
   * C1.8: "restoration after purge must be impossible by construction, not
   * merely unexposed."
   *
   * There are exactly two entry points into restore — the password endpoint
   * and the Google callback — and both compose the same two guards:
   * `findSoftDeletedUserByEmail`, whose predicate excludes purged rows, and
   * `restoreAccountById`, which refuses one under the row lock. This block
   * exercises that *composition*, with the lookup modelling the real
   * predicate over an in-memory row rather than being told what to return, so
   * it is the closure being asserted and not the mock.
   *
   * (The two guards are asserted individually in `users.service.spec.ts`.)
   */
  describe('purge is terminal — no code path restores a purged account (C1.8)', () => {
    const purgedRow = {
      ...mockUser,
      id: 99,
      // What the purge actually leaves behind: the original address is gone,
      // there is no password hash, and purgedAt is stamped.
      email: 'deleted-user-99@deleted.invalid',
      password: null,
      deletedAt: subDays(new Date(), 60),
      purgedAt: subDays(new Date(), 30),
    };

    beforeEach(() => {
      mockUsersService.findUserByEmail.mockResolvedValue(null);
      // The real query is `WHERE email = ? AND deleted_at IS NOT NULL AND
      // purged_at IS NULL`, so it can resolve neither the original address
      // (overwritten) nor the placeholder (purged).
      mockUsersService.findSoftDeletedUserByEmail.mockImplementation(
        (email: string): Promise<null> => {
          const matches = email === purgedRow.email && !purgedRow.purgedAt;
          return Promise.resolve(matches ? (purgedRow as never) : null);
        },
      );
    });

    it('cannot be restored through POST /auth/restore-account, by either address', async () => {
      for (const email of ['gone@example.com', purgedRow.email]) {
        await expect(
          service.restoreAccount({ email, password: 'pass' }),
        ).rejects.toThrow(InvalidCredentialsException);
      }
      expect(mockUsersService.restoreAccountById).not.toHaveBeenCalled();
    });

    // Indistinguishable from an address that was never registered, per C1.7.
    it('cannot be discovered through login, even with the right password', async () => {
      await expect(
        service.loginUser({ email: purgedRow.email, password: 'pass' }),
      ).rejects.toThrow(InvalidCredentialsException);
      expect(
        mockUsersService.getSoftDeletedPasswordCheckResult,
      ).not.toHaveBeenCalled();
    });

    it('cannot be restored through the Google callback either', async () => {
      mockOAuthStateService.consumeState.mockReturnValueOnce({
        role: Role.CUSTOMER,
      });
      mockSocialAuthStrategyFactory.getStrategy.mockReturnValue({
        getAccessToken: jest.fn().mockResolvedValue('provider-token'),
        getUserProfile: jest.fn().mockResolvedValue({
          email: purgedRow.email,
          firstname: 'Ama',
          lastname: 'Owusu',
          provider: 'google',
          providerId: 'google-id-9',
        }),
      });
      mockUserTokenService.createJWTTokens.mockResolvedValue({
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_at: new Date(),
      });
      mockUsersService.createUser.mockResolvedValueOnce({
        data: { ...mockUser, id: 100 },
      });

      await service.handleOAuthCallback('google', {
        code: 'auth-code',
        state: 'state-123',
      } as OAuthCallbackDto);

      // The purged row is invisible to the restore lookup, so the callback
      // treats this as a brand-new signup — it never resurrects the old
      // account, and never emits a restore confirmation for it.
      expect(mockUsersService.restoreAccountById).not.toHaveBeenCalled();
      expect(mockEmitter.emit).not.toHaveBeenCalledWith(
        MailEvent.ACCOUNT_RESTORED,
        expect.anything(),
      );
    });
  });

  /**
   * Item 5 (security `M5`, login half): no line `loginUser` emits may contain
   * the submitted address, for **any** outcome — and each one must still
   * identify the account well enough to debug a failed login.
   *
   * Every login outcome is enumerated rather than a couple of representative
   * ones, because the leak this replaces was a single line on a single branch.
   * Register and the social-login paths are deliberately excluded: they are
   * out of scope for this round (`M5` stays partially open by decision), and
   * asserting on them here would fail for a reason nobody intended to fix yet.
   */
  describe('no email addresses in login-path logs (M5)', () => {
    const EMAIL = 'leak-check@example.com';
    const USER_ID = 4242;

    const liveUser = (overrides: Record<string, unknown> = {}) => ({
      ...mockUser,
      id: USER_ID,
      email: EMAIL,
      ...overrides,
    });

    /** Captures every level, since the leak was on a `warn`. */
    const captureLogs = () => {
      const spies = (['log', 'warn', 'error'] as const).map((level) =>
        jest.spyOn(service['logger'], level).mockImplementation(() => {}),
      );
      return () =>
        spies.flatMap((spy) =>
          (spy.mock.calls as unknown[][]).map((call) => String(call[0])),
        );
    };

    const outcomes: { label: string; arrange: () => void }[] = [
      {
        label: 'success',
        arrange: () => {
          mockUsersService.findUserByEmail.mockResolvedValueOnce(liveUser());
          mockUserTokenService.createJWTTokens.mockResolvedValueOnce({
            access_token: 'a',
            refresh_token: 'r',
            expires_at: new Date(),
          });
        },
      },
      {
        label: 'wrong password on a live account',
        arrange: () => {
          mockUsersService.findUserByEmail.mockResolvedValueOnce(liveUser());
          mockUsersService.getPasswordCheckResult.mockResolvedValueOnce({
            hasPassword: true,
            isValid: false,
          });
        },
      },
      {
        label: 'social-only account',
        arrange: () => {
          mockUsersService.findUserByEmail.mockResolvedValueOnce(liveUser());
          mockUsersService.getPasswordCheckResult.mockResolvedValueOnce({
            hasPassword: false,
            isValid: false,
          });
        },
      },
      {
        label: 'unverified account',
        arrange: () => {
          mockUsersService.findUserByEmail.mockResolvedValueOnce(
            liveUser({ accountVerified: false }),
          );
        },
      },
      {
        label: 'never-registered address',
        arrange: () => {
          mockUsersService.findUserByEmail.mockResolvedValueOnce(null);
          mockUsersService.findSoftDeletedUserByEmail.mockResolvedValueOnce(
            null,
          );
        },
      },
      {
        label: 'wrong password on a soft-deleted account',
        arrange: () => {
          mockUsersService.findUserByEmail.mockResolvedValueOnce(null);
          mockUsersService.findSoftDeletedUserByEmail.mockResolvedValueOnce({
            id: USER_ID,
            email: EMAIL,
            deletedAt: new Date(),
          });
          mockUsersService.getSoftDeletedPasswordCheckResult.mockResolvedValueOnce(
            { hasPassword: true, isValid: false },
          );
        },
      },
      {
        label: 'restorable soft-deleted account with the right password',
        arrange: () => {
          mockUsersService.findUserByEmail.mockResolvedValueOnce(null);
          mockUsersService.findSoftDeletedUserByEmail.mockResolvedValueOnce({
            id: USER_ID,
            email: EMAIL,
            deletedAt: new Date(),
          });
          mockUsersService.getSoftDeletedPasswordCheckResult.mockResolvedValueOnce(
            { hasPassword: true, isValid: true },
          );
        },
      },
      {
        label: 'soft-deleted account past its window',
        arrange: () => {
          mockUsersService.findUserByEmail.mockResolvedValueOnce(null);
          mockUsersService.findSoftDeletedUserByEmail.mockResolvedValueOnce({
            id: USER_ID,
            email: EMAIL,
            deletedAt: subDays(new Date(), 31),
          });
          mockUsersService.getSoftDeletedPasswordCheckResult.mockResolvedValueOnce(
            { hasPassword: true, isValid: true },
          );
        },
      },
    ];

    it.each(outcomes)(
      'writes no email address for the $label outcome',
      async ({ arrange }) => {
        arrange();
        const readLogs = captureLogs();

        await service
          .loginUser({ email: EMAIL, password: 'CorrectHorse1!' })
          .catch(() => undefined);

        const lines = readLogs();
        expect(lines.length).toBeGreaterThan(0);
        for (const line of lines) {
          expect(line).not.toContain(EMAIL);
          // Not just the full address: no local part, no domain either.
          expect(line).not.toContain('leak-check');
          expect(line).not.toContain('example.com');
        }
      },
    );

    it('still identifies the account, so a failed login is debuggable', async () => {
      mockUsersService.findUserByEmail.mockResolvedValueOnce(liveUser());
      mockUsersService.getPasswordCheckResult.mockResolvedValueOnce({
        hasPassword: true,
        isValid: false,
      });
      const readLogs = captureLogs();

      await service
        .loginUser({ email: EMAIL, password: 'WrongHorse1!' })
        .catch(() => undefined);

      const lines = readLogs();
      // The id where the address used to be …
      expect(lines.some((line) => line.includes(`user ${USER_ID}`))).toBe(true);
      // … and the hash on the one line that runs before any row is resolved,
      // so the attempt can still be correlated end to end.
      expect(lines.some((line) => line.includes(hashEmailForLog(EMAIL)))).toBe(
        true,
      );
    });

    /**
     * The hash is computed from the submitted string before any lookup, so it
     * cannot carry account state. If it ever did, log read access would become
     * the enumeration oracle the response bodies deliberately are not.
     */
    it('logs the same correlation key for a registered and an unregistered address', async () => {
      mockUsersService.findUserByEmail.mockResolvedValueOnce(liveUser());
      mockUserTokenService.createJWTTokens.mockResolvedValueOnce({
        access_token: 'a',
        refresh_token: 'r',
        expires_at: new Date(),
      });
      const readRegistered = captureLogs();
      await service
        .loginUser({ email: EMAIL, password: 'CorrectHorse1!' })
        .catch(() => undefined);
      const registeredEntry = readRegistered().find((line) =>
        line.startsWith('Processing login request'),
      );
      jest.restoreAllMocks();

      mockUsersService.findUserByEmail.mockResolvedValueOnce(null);
      mockUsersService.findSoftDeletedUserByEmail.mockResolvedValueOnce(null);
      const readUnknown = captureLogs();
      await service
        .loginUser({ email: EMAIL, password: 'CorrectHorse1!' })
        .catch(() => undefined);
      const unknownEntry = readUnknown().find((line) =>
        line.startsWith('Processing login request'),
      );

      expect(registeredEntry).toBeDefined();
      expect(unknownEntry).toBe(registeredEntry);
    });
  });

  /**
   * Item 1 (security `L3` / qa `B5`): no auth response may carry credential
   * material or admin-only moderation state.
   *
   * Register and change-password are asserted specifically because they are
   * the two sites where the hash is genuinely non-empty: both serialise an
   * in-memory `User` that carries a freshly-computed hash regardless of the
   * column's `select: false`, and change-password — the one QA never tested —
   * returns the hash of the password the caller typed a moment earlier.
   *
   * Assertions run against the JSON the client would actually receive
   * (`JSON.parse(JSON.stringify(…))`), not against the instance, so a key that
   * exists with an `undefined` value cannot pass by accident and a key that
   * really would be serialised cannot hide.
   */
  describe('no credential material or admin-only fields in auth responses (L3/B5)', () => {
    /** Everything a real `users` row carries into these two call sites. */
    const rowWithSecrets = () => ({
      id: 42,
      email: 'hygiene@example.com',
      username: 'hygiene',
      firstname: 'Hy',
      lastname: 'Giene',
      phoneNumber: '024-000-0000',
      role: Role.ARTISAN,
      accountVerified: true,
      // Credential material. Present in memory despite `select: false`.
      password: '$2b$12$AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg',
      // Admin-only moderation state — `suspensionReason` is documented on the
      // entity as "shown to the admin, not to the user".
      isBanned: true,
      bannedAt: new Date('2026-01-01T00:00:00.000Z'),
      bannedById: 3,
      isSuspended: true,
      suspendedAt: new Date('2026-01-02T00:00:00.000Z'),
      suspendedById: 3,
      suspensionReason: 'internal moderation note',
      deletedAt: new Date('2026-01-03T00:00:00.000Z'),
      purgedAt: null,
      createdAt: new Date('2025-12-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-04T00:00:00.000Z'),
    });

    const FORBIDDEN_KEYS = [
      'password',
      'isBanned',
      'bannedAt',
      'bannedById',
      'isSuspended',
      'suspendedAt',
      'suspendedById',
      'suspensionReason',
      'deletedAt',
      'purgedAt',
    ];

    /** What the frontend drives redirects and the dashboard shell from. */
    const REQUIRED_KEYS = ['id', 'email', 'role'];

    const asWireFormat = (payload: unknown): Record<string, unknown> =>
      JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;

    const assertClean = (userPayload: unknown, whole: unknown) => {
      // No `$2b$`-prefixed string anywhere in the response, at any depth.
      expect(JSON.stringify(whole)).not.toContain('$2b$');
      const keys = Object.keys(asWireFormat(userPayload));
      for (const key of FORBIDDEN_KEYS) {
        expect(keys).not.toContain(key);
      }
      for (const key of REQUIRED_KEYS) {
        expect(keys).toContain(key);
      }
    };

    it('POST /auth/register returns no password key and no hash anywhere in the body', async () => {
      mockUsersService.isEmailRegistered.mockResolvedValueOnce(false);
      mockUsersService.createUser.mockResolvedValueOnce({
        data: rowWithSecrets(),
      });
      mockUserTokenService.createToken.mockResolvedValueOnce({
        token: 'verification-token',
      });

      const result = await service.registerUser({
        email: 'hygiene@example.com',
        password: 'CorrectHorse1!',
        role: Role.ARTISAN,
      } as CreateUserDto);

      assertClean(result, result);
    });

    it('POST /auth/change-password returns no password key, including the hash it just computed', async () => {
      const row = rowWithSecrets();
      mockUsersService.findUserById.mockResolvedValueOnce(row);
      mockUsersService.validatePassword.mockResolvedValueOnce(true);
      mockUsersService.updateUserData.mockResolvedValueOnce(undefined);
      mockUserTokenService.revokeRefreshTokenForUser.mockResolvedValueOnce(
        undefined,
      );
      mockUserTokenService.createJWTTokens.mockResolvedValueOnce({
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_at: new Date(),
      });

      const { result } = await service.changePassword(
        {
          currentPassword: 'CorrectHorse1!',
          newPassword: 'NewHorse1!',
          confirmNewPassword: 'NewHorse1!',
        } as never,
        row.id,
      );

      // The hash really was rewritten onto the object being serialised —
      // without that, this test would pass for the wrong reason.
      expect(row.password.startsWith('$2b$')).toBe(true);
      expect(row.password).not.toBe(rowWithSecrets().password);
      assertClean(result.data, result);
    });

    it('POST /auth/login carries only declared profile fields', async () => {
      mockUsersService.findUserByEmail.mockResolvedValueOnce(rowWithSecrets());
      mockUserTokenService.createJWTTokens.mockResolvedValueOnce({
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_at: new Date(),
      });

      const { result } = await service.loginUser({
        email: 'hygiene@example.com',
        password: 'CorrectHorse1!',
      });

      assertClean(result.data, result);
    });

    /**
     * The structural half of the fix, and the one that outlives this round: a
     * future call site that forgets `excludeExtraneousValues` must still be
     * unable to leak. Deleting the `password` property was not enough on its
     * own — with the option off, class-transformer copies every own property
     * of the source — so `UserResponseDto` carries a class-level `@Exclude()`.
     */
    it('cannot leak the hash even from a call site that forgets the exclusion option', () => {
      const dto = plainToInstance(UserResponseDto, rowWithSecrets());

      const keys = Object.keys(asWireFormat(dto));
      expect(JSON.stringify(dto)).not.toContain('$2b$');
      for (const key of FORBIDDEN_KEYS) {
        expect(keys).not.toContain(key);
      }
      expect(keys).toEqual(expect.arrayContaining(REQUIRED_KEYS));
    });
  });
});
