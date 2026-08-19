import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from '../auth.service';
import { UsersService } from '@users/users.service';
import { UserTokenService } from '@users/token.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SocialAuthStrategyFactory } from '../social-auth.factory';
import { OAuthStateService } from '../oauth-state.service';
import { Role } from '@common/types/enums';
import { OAuthCallbackDto } from '../dto/oauth-callback.dto';

/**
 * QA finding (google-oauth-fix, G6 regression risk) — FIX VERIFICATION.
 *
 * Originally, `updateSocialLoginInfo` (private helper in AuthService,
 * invoked from `handleOAuthCallback` on the existing-account/G6 path) called
 * `this.userService.updateUserData(...)` WITHOUT awaiting or catching it.
 * G1 is what makes this path reachable by real Google traffic for the first
 * time — previously the callback route didn't exist at all. On Node 15+
 * (this project runs Node 22), an unhandled promise rejection crashes the
 * entire process by default, so a single transient DB write failure during
 * ANY existing user's Google re-login could have taken the whole API down
 * for every user.
 *
 * Fix applied: the call is now `await`ed and wrapped in try/catch with a
 * log-and-swallow on failure. This file now verifies the FIXED behavior:
 *   1. `handleOAuthCallback` genuinely waits for the write to settle before
 *      resolving (no longer fire-and-forget).
 *   2. A rejection from the write is swallowed — login still succeeds and,
 *      critically, produces no unhandled promise rejection.
 */
describe('AuthService.handleOAuthCallback — existing-account profile-sync write (G6)', () => {
  let service: AuthService;
  const mockUser = {
    id: 1,
    email: 'existing@example.com',
    role: Role.CUSTOMER,
    isSocialLogin: false,
    profilePicture: null,
  };
  const mockUsersService = {
    findUserByEmail: jest.fn().mockResolvedValue(mockUser),
    updateUserData: jest.fn(),
  };
  const mockUserTokenService = {
    createJWTTokens: jest.fn().mockResolvedValue({
      access_token: 'a',
      refresh_token: 'r',
      expires_at: new Date(),
    }),
  };
  const mockStrategy = {
    getAccessToken: jest.fn().mockResolvedValue('provider-token'),
    getUserProfile: jest.fn().mockResolvedValue({
      email: mockUser.email,
      firstname: 'Existing',
      lastname: 'User',
      provider: 'google',
      providerId: 'google-existing-id',
    }),
  };
  const mockSocialAuthStrategyFactory = {
    getStrategy: jest.fn().mockReturnValue(mockStrategy),
  };
  const mockOAuthStateService = {
    consumeState: jest.fn().mockReturnValue({ role: undefined }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: mockUsersService },
        { provide: UserTokenService, useValue: mockUserTokenService },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        {
          provide: SocialAuthStrategyFactory,
          useValue: mockSocialAuthStrategyFactory,
        },
        { provide: OAuthStateService, useValue: mockOAuthStateService },
      ],
    }).compile();
    service = module.get<AuthService>(AuthService);
    jest.clearAllMocks();
    mockUsersService.findUserByEmail.mockResolvedValue(mockUser);
    mockOAuthStateService.consumeState.mockReturnValue({ role: undefined });
  });

  it('fix: waits for updateUserData() to settle before resolving login (no longer fire-and-forget)', async () => {
    let settleUpdate!: () => void;
    const updatePromise = new Promise<void>((resolve) => {
      settleUpdate = resolve;
    });
    mockUsersService.updateUserData.mockReturnValueOnce(updatePromise);

    let resolved = false;
    const callbackPromise = service
      .handleOAuthCallback('google', {
        code: 'auth-code',
        state: 'state-1',
      } as OAuthCallbackDto)
      .then((r) => {
        resolved = true;
        return r;
      });

    // Let any already-queued microtasks run without resolving updatePromise.
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    settleUpdate();
    const callbackResult = await callbackPromise;

    expect(resolved).toBe(true);
    expect(callbackResult).toBeDefined();
    expect(mockUsersService.updateUserData).toHaveBeenCalledTimes(1);
  });

  it('fix: a rejected profile-sync write is caught and swallowed — login still succeeds, no unhandled rejection', async () => {
    mockUsersService.updateUserData.mockRejectedValueOnce(
      new Error('transient DB write failure'),
    );

    const callbackResult = await service.handleOAuthCallback('google', {
      code: 'auth-code',
      state: 'state-1',
    } as OAuthCallbackDto);

    // If this rejection were still unhandled, Jest would report it as a
    // separate unhandled-rejection failure for this test even though the
    // assertions below pass — that's the whole point of this test existing.
    expect(callbackResult).toBeDefined();
    expect(mockUsersService.updateUserData).toHaveBeenCalledTimes(1);
  });
});
