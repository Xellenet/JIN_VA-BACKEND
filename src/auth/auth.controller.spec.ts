import { Test, TestingModule } from '@nestjs/testing';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { RegisterUserDto } from './dto/register-user.dto';
import { UserResponseDto } from '@users/dto/user-response.dto';
import { LoginDto } from './dto/login.dto';
import { LoginResponseDto } from './dto/login-response.dto';
import { Role } from '@common/types/enums';
import { UnauthorizedException } from '@nestjs/common';
import { UserAlreadyExists } from '@common/exceptions/user-already-exists.exception';
import { VARIABLES } from '@common/constants/variables.constants';
import type { CompleteSocialSignupDto } from './dto/complete-social-signup.dto';
import {
  AuthCredentialsThrottlerGuard,
  AuthEmailThrottlerGuard,
} from './guards/auth-throttler.guard';

describe('AuthController', () => {
  let controller: AuthController;
  let authService: AuthService;

  const mockAuthService = {
    registerUser: jest.fn(),
    loginUser: jest.fn(),
    initiateOAuthFlow: jest.fn(),
    handleOAuthCallback: jest.fn(),
    getPendingSocialSignup: jest.fn(),
    completeSocialSignup: jest.fn(),
    cancelSocialSignup: jest.fn(),
  };

  // Minimal stand-in for Express' Response — `cookie()` is exercised by the
  // httpOnly refresh/session cookie helpers (S1/S2), `redirect()` by the
  // Google OAuth routes (G1/G3/G4).
  const mockRes = {
    cookie: jest.fn(),
    redirect: jest.fn(),
  } as unknown as import('express').Response;

  const ORIGINAL_FRONTEND_URL = process.env.FRONTEND_URL;

  /** Flushes pending microtasks/macrotasks — needed for `googleLogin`, which
   * fires its redirect from inside a `.then()/.catch()` chain rather than an
   * awaited async function body. */
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  beforeAll(() => {
    process.env.FRONTEND_URL = 'https://app.example.com';
  });

  afterAll(() => {
    process.env.FRONTEND_URL = ORIGINAL_FRONTEND_URL;
  });

  /**
   * These specs call the handlers directly, so guards never run — but the
   * throttler guards attached to most of these routes are real providers with
   * real dependencies (`THROTTLER:MODULE_OPTIONS`, supplied by
   * `ThrottlingModule` in the running app), and Nest instantiates a
   * controller's guards while compiling the module. Stubbing them keeps this a
   * controller unit test instead of dragging the throttler configuration in;
   * the limits themselves are covered by `guards/auth-throttler.guard.spec.ts`
   * and `test/auth-rate-limit.e2e-spec.ts`.
   */
  const allowAll = { canActivate: () => true };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: mockAuthService }],
    })
      .overrideGuard(AuthCredentialsThrottlerGuard)
      .useValue(allowAll)
      .overrideGuard(AuthEmailThrottlerGuard)
      .useValue(allowAll)
      .compile();

    controller = module.get<AuthController>(AuthController);
    authService = module.get<AuthService>(AuthService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('registerUser', () => {
    it('should call authService.registerUser and return result', async () => {
      const dto: RegisterUserDto = {
        email: 'test@example.com',
        password: 'pass',
      } as RegisterUserDto;
      const expected = { id: 1, email: dto.email } as UserResponseDto;
      mockAuthService.registerUser.mockResolvedValueOnce(expected);

      const result = await controller.registerUser(dto);

      expect(authService.registerUser).toHaveBeenCalledWith(dto);
      expect(result).toEqual(expected);
    });
  });

  describe('loginUser', () => {
    const cookieCalls = () =>
      (mockRes.cookie as jest.Mock).mock.calls.map(
        ([name, , opts]: [string, string, { maxAge?: number }]) =>
          `${name}:${opts.maxAge === 0 ? 'cleared' : 'set'}`,
      );

    it('should call authService.loginUser, set the httpOnly cookies, and return only the body result', async () => {
      const loginDto: LoginDto = {
        email: 'test@example.com',
        password: 'pass',
      };
      const expectedResult = {
        access_token: 'token',
        data: { id: 1, role: Role.CUSTOMER },
      } as LoginResponseDto;
      mockAuthService.loginUser.mockResolvedValueOnce({
        result: expectedResult,
        refreshToken: 'refresh-token',
      });

      const result = await controller.loginUser(loginDto, mockRes);

      expect(authService.loginUser).toHaveBeenCalledWith(loginDto);
      // The refresh token must never be present on the returned body (S1).
      expect(result).toEqual(expectedResult);
      expect(result).not.toHaveProperty('refresh_token');
      expect(result).not.toHaveProperty('refreshToken');
      // Both httpOnly cookies must be set: the refresh token and the S2
      // role/auth signal, persistent by default (QA AUTH-31), and the
      // session-only marker cleared.
      expect(cookieCalls()).toEqual([
        `${VARIABLES.REFRESH_TOKEN_COOKIE_NAME}:set`,
        `${VARIABLES.AUTH_SESSION_COOKIE_NAME}:set`,
        'jinva_session_only:cleared',
      ]);
      for (const [, , options] of (
        mockRes.cookie as jest.Mock
      ).mock.calls.slice(0, 2) as [string, string, { maxAge?: number }][]) {
        expect(options.maxAge).toBeGreaterThan(0);
      }
    });

    it('keeps the sign-in to the browser session when "Remember me" is unticked (QA AUTH-31)', async () => {
      mockAuthService.loginUser.mockResolvedValueOnce({
        result: { access_token: 'token', data: { id: 1, role: Role.CUSTOMER } },
        refreshToken: 'refresh-token',
      });

      await controller.loginUser(
        { email: 'test@example.com', password: 'pass', rememberMe: false },
        mockRes,
      );

      const calls = (mockRes.cookie as jest.Mock).mock.calls as [
        string,
        string,
        { maxAge?: number },
      ][];
      for (const [name, , options] of calls) {
        if (name === 'jinva_session_only') continue;
        expect(options.maxAge).toBeUndefined();
      }
      expect(cookieCalls()).toContain('jinva_session_only:set');
    });
  });

  describe('googleLogin (G1/G9)', () => {
    it('forwards the role query param and redirects to the URL from initiateOAuthFlow', async () => {
      mockAuthService.initiateOAuthFlow.mockResolvedValueOnce(
        'https://accounts.google.com/o/oauth2/v2/auth?state=abc',
      );

      controller.googleLogin('artisan', mockRes);
      await flush();

      expect(mockAuthService.initiateOAuthFlow).toHaveBeenCalledWith(
        'google',
        'artisan',
      );
      expect(mockRes.redirect).toHaveBeenCalledWith(
        'https://accounts.google.com/o/oauth2/v2/auth?state=abc',
      );
    });

    it('redirects to the frontend with ?error=oauth_failed if initiation itself throws', async () => {
      mockAuthService.initiateOAuthFlow.mockRejectedValueOnce(
        new Error('Google OAuth is misconfigured'),
      );

      controller.googleLogin(undefined, mockRes);
      await flush();

      expect(mockRes.redirect).toHaveBeenCalledWith(
        'https://app.example.com/auth/callback?error=oauth_failed',
      );
    });
  });

  describe('googleCallback (G1/G3/G4)', () => {
    it('sets both httpOnly cookies and redirects to the frontend landing route on success, never returning the body', async () => {
      const expectedResult = {
        access_token: 'token',
        data: { id: 1, role: Role.CUSTOMER },
      } as LoginResponseDto;
      mockAuthService.handleOAuthCallback.mockResolvedValueOnce({
        result: expectedResult,
        refreshToken: 'refresh-token',
      });

      await controller.googleCallback(
        { code: 'auth-code', state: 'state-123' },
        mockRes,
      );

      expect(mockAuthService.handleOAuthCallback).toHaveBeenCalledWith(
        'google',
        {
          code: 'auth-code',
          state: 'state-123',
          error: undefined,
          error_description: undefined,
        },
      );
      // G3: same httpOnly cookie contract as POST /auth/login (the two auth
      // cookies, plus clearing any "Remember me" session-only marker).
      expect(mockRes.cookie).toHaveBeenCalledTimes(3);
      // G4: redirect, never a JSON body.
      expect(mockRes.redirect).toHaveBeenCalledWith(
        'https://app.example.com/auth/callback',
      );
    });

    it('redirects with ?error=access_denied when Google reports denied/cancelled consent, never raw JSON', async () => {
      mockAuthService.handleOAuthCallback.mockRejectedValueOnce(
        new Error('Authentication failed with google'),
      );

      await controller.googleCallback(
        { error: 'access_denied', error_description: 'User cancelled' },
        mockRes,
      );

      expect(mockRes.redirect).toHaveBeenCalledWith(
        'https://app.example.com/auth/callback?error=access_denied',
      );
      expect(mockRes.cookie).not.toHaveBeenCalled();
    });

    it('redirects with ?error=oauth_failed for any other failure (e.g. invalid/expired/replayed state)', async () => {
      mockAuthService.handleOAuthCallback.mockRejectedValueOnce(
        new Error('Invalid or expired OAuth state'),
      );

      await controller.googleCallback(
        { code: 'auth-code', state: 'stale-state' },
        mockRes,
      );

      expect(mockRes.redirect).toHaveBeenCalledWith(
        'https://app.example.com/auth/callback?error=oauth_failed',
      );
      expect(mockRes.cookie).not.toHaveBeenCalled();
    });

    it('for a brand-new user sets only the pending-signup cookie and redirects to complete-signup', async () => {
      mockAuthService.handleOAuthCallback.mockResolvedValueOnce({
        pendingSignupKey: 'pending-key',
      });

      await controller.googleCallback(
        { code: 'auth-code', state: 'state-123' },
        mockRes,
      );

      expect(mockRes.cookie).toHaveBeenCalledTimes(1);
      expect(mockRes.cookie).toHaveBeenCalledWith(
        VARIABLES.PENDING_SOCIAL_SIGNUP_COOKIE_NAME,
        'pending-key',
        expect.objectContaining({
          httpOnly: true,
          sameSite: 'lax',
          path: '/api/v1/auth',
          maxAge: VARIABLES.PENDING_SOCIAL_SIGNUP_TTL_MS,
        }),
      );
      expect(mockRes.redirect).toHaveBeenCalledWith(
        'https://app.example.com/auth/complete-signup',
      );
    });
  });

  describe('social signup routes', () => {
    const reqWithKey = {
      cookies: { [VARIABLES.PENDING_SOCIAL_SIGNUP_COOKIE_NAME]: 'pending-key' },
    } as unknown as import('express').Request;
    const dto = { role: Role.CUSTOMER } as CompleteSocialSignupDto;

    /** Names of the cookies set (value non-empty) vs cleared (maxAge 0). */
    const cookieCalls = () =>
      (mockRes.cookie as jest.Mock).mock.calls.map(
        ([name, , opts]: [string, string, { maxAge?: number }]) =>
          `${name}:${opts.maxAge === 0 ? 'cleared' : 'set'}`,
      );

    it('GET social/pending passes the cookie key through', () => {
      const body = { message: 'ok', data: { email: 'a@b.c' } };
      mockAuthService.getPendingSocialSignup.mockReturnValueOnce(body);

      expect(controller.getPendingSocialSignup(reqWithKey)).toBe(body);
      expect(mockAuthService.getPendingSocialSignup).toHaveBeenCalledWith(
        'pending-key',
      );
    });

    it('POST social/complete sets the session cookies like login and clears the pending one', async () => {
      const result = {
        access_token: 'token',
        data: { id: 5, role: Role.ARTISAN },
      } as LoginResponseDto;
      mockAuthService.completeSocialSignup.mockResolvedValueOnce({
        result,
        refreshToken: 'refresh-token',
      });

      const response = await controller.completeSocialSignup(
        dto,
        reqWithKey,
        mockRes,
      );

      expect(response).toBe(result);
      expect(mockAuthService.completeSocialSignup).toHaveBeenCalledWith(
        'pending-key',
        dto,
      );
      expect(cookieCalls()).toEqual([
        `${VARIABLES.PENDING_SOCIAL_SIGNUP_COOKIE_NAME}:cleared`,
        `${VARIABLES.REFRESH_TOKEN_COOKIE_NAME}:set`,
        `${VARIABLES.AUTH_SESSION_COOKIE_NAME}:set`,
        'jinva_session_only:cleared',
      ]);
    });

    it('POST social/complete clears the pending cookie on 409 (the entry can never complete)', async () => {
      mockAuthService.completeSocialSignup.mockRejectedValueOnce(
        new UserAlreadyExists('taken'),
      );

      await expect(
        controller.completeSocialSignup(dto, reqWithKey, mockRes),
      ).rejects.toThrow(UserAlreadyExists);
      expect(cookieCalls()).toEqual([
        `${VARIABLES.PENDING_SOCIAL_SIGNUP_COOKIE_NAME}:cleared`,
      ]);
    });

    it('POST social/complete sets no cookies on other failures', async () => {
      mockAuthService.completeSocialSignup.mockRejectedValueOnce(
        new UnauthorizedException(),
      );

      await expect(
        controller.completeSocialSignup(dto, reqWithKey, mockRes),
      ).rejects.toThrow(UnauthorizedException);
      expect(mockRes.cookie).not.toHaveBeenCalled();
    });

    it('POST social/cancel discards the entry and clears the cookie', () => {
      const response = controller.cancelSocialSignup(reqWithKey, mockRes);

      expect(typeof response.message).toBe('string');
      expect(mockAuthService.cancelSocialSignup).toHaveBeenCalledWith(
        'pending-key',
      );
      expect(cookieCalls()).toEqual([
        `${VARIABLES.PENDING_SOCIAL_SIGNUP_COOKIE_NAME}:cleared`,
      ]);
    });
  });
});
