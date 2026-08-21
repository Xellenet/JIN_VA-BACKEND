import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { SocialAuthStrategy } from './social-auth.strategy';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { SocialUserProfile } from '@common/types/user-interfaces.type';
import { VARIABLES } from '@common/constants/variables.constants';

interface GoogleTokenResponse {
  access_token: string;
}

interface GoogleUserInfoResponse {
  email: string;
  given_name: string;
  family_name: string;
  picture: string;
  sub: string;
}

@Injectable()
export class GoogleAuthStrategy implements SocialAuthStrategy {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;
  private readonly logger = new Logger(GoogleAuthStrategy.name);

  constructor(private readonly httpService: HttpService) {
    this.clientId = process.env.GOOGLE_CLIENT_ID as string;
    this.clientSecret = process.env.GOOGLE_CLIENT_SECRET as string;

    // G2: the redirect URI may be configured under either name depending on
    // which env convention was used — prefer GOOGLE_REDIRECT_URI, fall back to
    // the historical GOOGLE_CALLBACK_URL. If neither is set we fail fast at
    // startup (this strategy is instantiated eagerly by
    // SocialAuthStrategyFactory) rather than silently sending Google an
    // `undefined` redirect_uri at request time.
    const redirectUri =
      process.env.GOOGLE_REDIRECT_URI || process.env.GOOGLE_CALLBACK_URL;
    if (!redirectUri) {
      throw new Error(
        'Google OAuth is misconfigured: set GOOGLE_REDIRECT_URI (or GOOGLE_CALLBACK_URL) ' +
          'to the fully-qualified callback URL registered with Google ' +
          '(e.g. https://api.example.com/api/v1/auth/google/callback).',
      );
    }
    this.redirectUri = redirectUri;
  }

  getAuthorizationUrl(state: string): string {
    this.logger.log(`Generating Google authorization URL`);
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: 'email profile',
      state,
      access_type: 'offline',
      prompt: 'consent',
    });

    return `${VARIABLES.GOOGLE_AUTHORIZATION_URL}?${params.toString()}`;
  }

  async getAccessToken(code: string): Promise<string> {
    this.logger.log(`Exchanging Google authorization code for access token`);
    try {
      const { data } = await firstValueFrom(
        this.httpService.post<GoogleTokenResponse>(VARIABLES.GOOGLE_TOKEN_URL, {
          code,
          client_id: this.clientId,
          client_secret: this.clientSecret,
          redirect_uri: this.redirectUri,
          grant_type: 'authorization_code',
        }),
      );

      this.logger.log(
        `Successfully exchanged Google authorization code for access token`,
      );
      return data.access_token;
    } catch (error) {
      this.logger.error('Error exchanging Google authorization code', error);
      throw new UnauthorizedException(
        'Failed to exchange Google authorization code',
      );
    }
  }

  async getUserProfile(accessToken: string): Promise<SocialUserProfile> {
    this.logger.log(`Fetching Google user profile using access token`);
    try {
      const { data } = await firstValueFrom(
        this.httpService.get<GoogleUserInfoResponse>(
          `${VARIABLES.GOOGLE_USERINFO_URL}?access_token=${accessToken}`,
        ),
      );
      this.logger.log(
        `Successfully fetched Google user profile for email: ${data.email}`,
      );

      return {
        email: data.email,
        firstname: data.given_name,
        lastname: data.family_name,
        profilePicture: data.picture,
        providerId: data.sub,
        provider: VARIABLES.GOOGLE_PROVIDER_NAME,
      };
    } catch (error) {
      this.logger.error('Error fetching Google user profile', error);
      throw new UnauthorizedException('Failed to get Google user profile');
    }
  }

  getProviderName(): string {
    return VARIABLES.GOOGLE_PROVIDER_NAME;
  }
}
