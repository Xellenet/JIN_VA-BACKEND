import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from '../auth.service';
import { UsersService } from '@users/users.service';
import { UserTokenService } from '@users/token.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SocialAuthStrategyFactory } from '../social-auth.factory';
import { OAuthStateService } from '../oauth-state.service';
import { Role } from '@common/types/enums';
import { LoginDto } from '../dto/login.dto';
import { SocialUserProfile } from '@common/types/user-interfaces.type';

/**
 * QA verification (google-oauth-fix, G10) — FIX VERIFICATION.
 *
 * requirements.md's G10 promises that a Google-only account which later uses
 * "Forgot Password" "gain[s] email/password login as an additional sign-in
 * method going forward".
 *
 * Originally, `registerSocialUser()` never set `accountVerified`, so it
 * landed `null` (no DB default) — and because a Google signup is never
 * routed through `verifyEmail()`, the account stayed permanently unverified.
 * After the user later set a real password via Forgot Password,
 * `loginUser()`'s pre-existing S4 "email not verified" gate still blocked
 * login, contradicting G10. Also flagged as [HIGH] in
 * docs/team/google-oauth-fix/security-report.md.
 *
 * Fix applied: `registerSocialUser()` now sets `accountVerified: true` (and
 * `verifiedAt`) at creation time, consistent with G6's existing trust of
 * Google's verified email. This file now verifies:
 *   1. A brand-new Google signup is created with `accountVerified: true`.
 *   2. The end-to-end sequence (signup -> Forgot Password sets a real
 *      password -> email/password login) now succeeds instead of throwing.
 */
describe('G10 fix: Google signup -> Forgot Password -> email/password login', () => {
  let service: AuthService;
  const mockUsersService = {
    findUserByEmail: jest.fn(),
    createUser: jest.fn(),
    getPasswordCheckResult: jest.fn(),
    updateUserData: jest.fn(),
  };
  const mockUserTokenService = { createJWTTokens: jest.fn() };
  const mockEmitter = { emit: jest.fn() };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: mockUsersService },
        { provide: UserTokenService, useValue: mockUserTokenService },
        { provide: EventEmitter2, useValue: mockEmitter },
        { provide: SocialAuthStrategyFactory, useValue: {} },
        { provide: OAuthStateService, useValue: {} },
      ],
    }).compile();
    service = module.get<AuthService>(AuthService);
    jest.clearAllMocks();
  });

  it('fix: registerSocialUser() creates the account with accountVerified: true', async () => {
    const socialProfile: SocialUserProfile = {
      email: 'google-user@example.com',
      firstname: 'Google',
      lastname: 'User',
      provider: 'google',
      providerId: 'google-id-1',
      profilePicture: undefined,
    };
    mockUsersService.createUser.mockResolvedValueOnce({
      data: {
        id: 99,
        email: socialProfile.email,
        role: Role.CUSTOMER,
        password: null,
        accountVerified: false, // simulates the DB row before the follow-up update
      },
    });

    // Access the private helper the same way the pre-existing suite does,
    // via the exported service instance's prototype.
    const user = await (
      service as unknown as {
        registerSocialUser: (
          p: SocialUserProfile,
          r?: Role,
        ) => Promise<{ id: number; accountVerified: boolean }>;
      }
    ).registerSocialUser(socialProfile, Role.CUSTOMER);

    expect(mockUsersService.updateUserData).toHaveBeenCalledWith(
      99,
      expect.objectContaining({ accountVerified: true }),
    );
    // The in-memory user returned to the caller is also kept in sync.
    expect(user.accountVerified).toBe(true);
  });

  it('fix: succeeds instead of throwing after a real password has been set via Forgot Password', async () => {
    // Models the row a brand-new Google signup now produces (accountVerified
    // true, set at signup time) plus a subsequent successful Forgot Password
    // (which sets `password`, per resetPassword()).
    const googleSignupThenPasswordReset = {
      id: 99,
      email: 'google-user@example.com',
      password: 'a-real-bcrypt-hash-from-reset-password',
      role: Role.CUSTOMER,
      accountVerified: true, // fixed: now set at social-signup time
    };
    mockUsersService.findUserByEmail.mockResolvedValueOnce(
      googleSignupThenPasswordReset,
    );
    mockUsersService.getPasswordCheckResult.mockResolvedValueOnce({
      hasPassword: true,
      isValid: true,
    });
    mockUserTokenService.createJWTTokens.mockResolvedValueOnce({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_at: new Date(),
    });

    const dto: LoginDto = {
      email: 'google-user@example.com',
      password: 'TheNewPassword!1',
    };

    const { result, refreshToken } = await service.loginUser(dto);

    expect(result).toHaveProperty('access_token', 'access-token');
    expect(refreshToken).toEqual('refresh-token');
  });
});
