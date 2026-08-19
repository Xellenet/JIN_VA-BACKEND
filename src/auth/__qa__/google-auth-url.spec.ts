import { HttpService } from '@nestjs/axios';
import { GoogleAuthStrategy } from '../strategy/google-auth.strategy';

/**
 * QA verification (google-oauth-fix, G1/G2): confirms the authorization URL
 * built by GoogleAuthStrategy is correctly formed — right base URL,
 * client_id, redirect_uri (via the G2 fallback chain), and scopes — using
 * fake, non-secret placeholder env values. Never reads any real .env file.
 */
describe('GoogleAuthStrategy — authorization URL shape (G1/G2)', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('builds a correctly-formed Google authorization URL using GOOGLE_REDIRECT_URI', () => {
    process.env.GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
    process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
    process.env.GOOGLE_REDIRECT_URI =
      'https://api.example.test/api/v1/auth/google/callback';
    delete process.env.GOOGLE_CALLBACK_URL;

    const strategy = new GoogleAuthStrategy({} as HttpService);
    const url = new URL(strategy.getAuthorizationUrl('csrf-state-value'));

    expect(url.origin + url.pathname).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
    expect(url.searchParams.get('client_id')).toBe(
      'test-client-id.apps.googleusercontent.com',
    );
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://api.example.test/api/v1/auth/google/callback',
    );
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('email profile');
    expect(url.searchParams.get('state')).toBe('csrf-state-value');
  });

  it('falls back to GOOGLE_CALLBACK_URL when GOOGLE_REDIRECT_URI is unset (G2)', () => {
    process.env.GOOGLE_CLIENT_ID = 'test-client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
    delete process.env.GOOGLE_REDIRECT_URI;
    process.env.GOOGLE_CALLBACK_URL =
      'https://legacy.example.test/api/v1/auth/google/callback';

    const strategy = new GoogleAuthStrategy({} as HttpService);
    const url = new URL(strategy.getAuthorizationUrl('state-2'));

    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://legacy.example.test/api/v1/auth/google/callback',
    );
  });

  it('prefers GOOGLE_REDIRECT_URI over GOOGLE_CALLBACK_URL when both are set (G2)', () => {
    process.env.GOOGLE_CLIENT_ID = 'test-client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
    process.env.GOOGLE_REDIRECT_URI = 'https://new.example.test/cb';
    process.env.GOOGLE_CALLBACK_URL = 'https://old.example.test/cb';

    const strategy = new GoogleAuthStrategy({} as HttpService);
    const url = new URL(strategy.getAuthorizationUrl('state-3'));

    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://new.example.test/cb',
    );
  });

  it('fails fast at construction when neither redirect-URI env var is set (G2)', () => {
    delete process.env.GOOGLE_REDIRECT_URI;
    delete process.env.GOOGLE_CALLBACK_URL;

    expect(() => new GoogleAuthStrategy({} as HttpService)).toThrow(
      /Google OAuth is misconfigured/,
    );
  });
});
