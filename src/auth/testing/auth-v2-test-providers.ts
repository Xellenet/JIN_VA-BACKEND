import type { Provider } from '@nestjs/common';
import { AccountSecurityService } from '../../account-security/account-security.service';
import { AuthSessionService } from '../auth-session.service';
import { CodeAuthService } from '../code-auth.service';
import { AuthCodeService } from '../codes/auth-code.service';
import { LoginFailureTracker } from '../login-failure-tracker.service';
import { TurnstileService } from '../turnstile/turnstile.service';

/**
 * Test-only: the auth v2 collaborators `AuthService` now depends on, for unit
 * specs that build it in a testing module. The session service is real (it
 * only needs the spec's `UserTokenService` and `EventEmitter2`), so token
 * issuing behaves as before; the code, security-log and Turnstile parts are
 * inert mocks the spec can inspect through the returned handles.
 */
export function authV2TestDoubles() {
  const accountSecurity = {
    record: jest.fn().mockResolvedValue(undefined),
    recordBestEffort: jest.fn().mockResolvedValue(undefined),
  };
  const codeAuth = {
    reserveOrThrow: jest.fn().mockResolvedValue({
      allowed: true,
      resendAvailableAt: new Date('2026-11-03T10:01:00.000Z'),
    }),
    deliverCode: jest.fn().mockResolvedValue(undefined),
  };
  const authCodes = {
    hashEmail: jest.fn((email: string) => `hash-of-${email.length}`),
  };
  const turnstile = {
    isEnabled: jest.fn().mockReturnValue(false),
    assertPassed: jest.fn().mockResolvedValue(undefined),
  };
  const providers: Provider[] = [
    AuthSessionService,
    LoginFailureTracker,
    { provide: AccountSecurityService, useValue: accountSecurity },
    { provide: CodeAuthService, useValue: codeAuth },
    { provide: AuthCodeService, useValue: authCodes },
    { provide: TurnstileService, useValue: turnstile },
  ];
  return { providers, accountSecurity, codeAuth, authCodes, turnstile };
}
