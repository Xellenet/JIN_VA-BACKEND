import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from '../auth.service';
import { UsersService } from '@users/users.service';
import { UserTokenService } from '@users/token.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SocialAuthStrategyFactory } from '../social-auth.factory';
import { OAuthStateService } from '../oauth-state.service';
import { PendingSocialSignupService } from '../pending-social-signup.service';
import { Gender, Role } from '@common/types/enums';
import { LoginDto } from '../dto/login.dto';

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
 * Google's verified email. Since the complete-signup step, that happens in
 * the same transaction that inserts the row (`createUserInTransaction`'s
 * `verifiedAt` option) rather than as a follow-up update, and the account is
 * created by `completeSocialSignup`. This file now verifies:
 *   1. A brand-new Google signup is created with `accountVerified: true`.
 *   2. The end-to-end sequence (signup -> Forgot Password sets a real
 *      password -> email/password login) now succeeds instead of throwing.
 */
describe('G10 fix: Google signup -> Forgot Password -> email/password login', () => {
  let service: AuthService;
  let pendingStore: PendingSocialSignupService;
  const mockUsersService = {
    findUserByEmail: jest.fn(),
    createUser: jest.fn(),
    createUserInTransaction: jest.fn(),
    isEmailRegistered: jest.fn(),
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
        PendingSocialSignupService,
      ],
    }).compile();
    service = module.get<AuthService>(AuthService);
    pendingStore = module.get(PendingSocialSignupService);
    jest.clearAllMocks();
  });

  it('fix: a completed Google signup creates the account with accountVerified: true', async () => {
    const key = pendingStore.create({
      email: 'google-user@example.com',
      firstname: 'Google',
      lastname: 'User',
      provider: 'google',
      providerId: 'google-id-1',
    });
    mockUsersService.isEmailRegistered.mockResolvedValueOnce(false);
    mockUsersService.createUserInTransaction.mockResolvedValueOnce({
      data: {
        id: 99,
        email: 'google-user@example.com',
        role: Role.CUSTOMER,
        password: null,
        accountVerified: true,
      },
    });
    mockUserTokenService.createJWTTokens.mockResolvedValueOnce({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_at: new Date(),
    });

    const { result } = await service.completeSocialSignup(key, {
      role: Role.CUSTOMER,
      firstname: 'Google',
      lastname: 'User',
      phoneNumber: '+233245551234',
      gender: Gender.MALE,
    });

    const [, options] = mockUsersService.createUserInTransaction.mock
      .calls[0] as [unknown, { verifiedAt?: Date }];
    expect(options.verifiedAt).toBeInstanceOf(Date);
    expect(result.data.accountVerified).toBe(true);
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
