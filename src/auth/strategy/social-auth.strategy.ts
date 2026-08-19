import { SocialUserProfile } from "@common/types/user-interfaces.type";

export interface SocialAuthStrategy {
  /**
   * Get authorization URL to redirect user to provider
   */
  getAuthorizationUrl(state: string): string;
  
  /**
   * Exchange authorization code for access token
   */
  getAccessToken(code: string): Promise<string>;
  
  /**
   * Get user profile using access token
   */
  getUserProfile(accessToken: string): Promise<SocialUserProfile>;
  
  /**
   * Returns the provider name (google, facebook, github, etc.)
   */
  getProviderName(): string;
}