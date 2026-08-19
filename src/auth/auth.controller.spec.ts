import { Test, TestingModule } from '@nestjs/testing';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { CreateUserDto } from '@users/dto/create-user.dto';
import { UserResponseDto } from '@users/dto/user-response.dto';
import { LoginDto } from './dto/login.dto';
import { LoginResponseDto } from './dto/login-response.dto';
import { Role } from '@common/types/enums';

describe('AuthController', () => {
  let controller: AuthController;
  let authService: AuthService;

  const mockAuthService = {
    registerUser: jest.fn(),
    loginUser: jest.fn(),
    initiateOAuthFlow: jest.fn(),
    handleOAuthCallback: jest.fn(),
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

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: mockAuthService }],
    }).compile();

    controller = module.get<AuthController>(AuthController);
    authService = module.get<AuthService>(AuthService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('registerUser', () => {
    it('should call authService.registerUser and return result', async () => {
      const dto: CreateUserDto = {
        email: 'test@example.com',
        password: 'pass',
      } as CreateUserDto;
      const expected = { id: 1, email: dto.email } as UserResponseDto;
      mockAuthService.registerUser.mockResolvedValueOnce(expected);

      const result = await controller.registerUser(dto);

      expect(authService.registerUser).toHaveBeenCalledWith(dto);
      expect(result).toEqual(expected);
    });
  });

  describe('loginUser', () => {
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
      // Both httpOnly cookies must be set: the refresh token and the S2 role/auth signal.
      expect(mockRes.cookie).toHaveBeenCalledTimes(2);
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
      // G3: same httpOnly cookie contract as POST /auth/login.
      expect(mockRes.cookie).toHaveBeenCalledTimes(2);
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
  });
});
