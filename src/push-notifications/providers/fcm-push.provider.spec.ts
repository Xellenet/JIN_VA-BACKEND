import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { FcmPushProvider } from './fcm-push.provider';

const initializeApp = jest.fn<void, unknown[]>();
const getApps = jest.fn<unknown[], []>(() => []);

jest.mock('firebase-admin/app', () => ({
  initializeApp: (...args: unknown[]) => initializeApp(...args),
  getApps: () => getApps(),
  cert: (c: unknown) => c,
}));
jest.mock('firebase-admin/messaging', () => ({ getMessaging: jest.fn() }));

function providerWith(env: Record<string, string>): FcmPushProvider {
  const config = { get: (key: string) => env[key] } as unknown as ConfigService;
  return new FcmPushProvider(config);
}

describe('FcmPushProvider boot', () => {
  beforeEach(() => {
    initializeApp.mockReset();
    getApps.mockReturnValue([]);
  });

  it('does not crash the app on a malformed credential, and logs the code only', () => {
    initializeApp.mockImplementation(() => {
      throw Object.assign(
        new Error('Failed to parse private key: SECRET-ish'),
        {
          code: 'app/invalid-credential',
        },
      );
    });
    const errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    expect(() =>
      providerWith({
        FIREBASE_PROJECT_ID: 'jinva-test',
        FIREBASE_CLIENT_EMAIL: 'not-a-service-account',
        FIREBASE_PRIVATE_KEY: 'definitely-not-a-key',
      }).onModuleInit(),
    ).not.toThrow();

    const logged = String(errorSpy.mock.calls[0][0]);
    expect(logged).toContain('app/invalid-credential');
    expect(logged).not.toContain('definitely-not-a-key');
    expect(logged).not.toContain('SECRET-ish');
    errorSpy.mockRestore();
  });

  it('stays inactive without a project id', () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    providerWith({}).onModuleInit();
    expect(initializeApp).not.toHaveBeenCalled();
  });

  it('sends nothing when the SDK never initialised', async () => {
    await expect(
      providerWith({}).send(['token'], { title: 't', body: 'b' }),
    ).resolves.toEqual({ successCount: 0, failedTokens: [] });
  });
});
