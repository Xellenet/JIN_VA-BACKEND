import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ERROR_MESSAGES } from '@common/constants/error-messages.constants';
import { UserAlreadyExists } from '@common/exceptions/user-already-exists.exception';
import { CreateUserDto } from '@users/dto/create-user.dto';
import { UsersService } from '@users/users.service';
import { plainToInstance } from 'class-transformer';
import { UserResponseDto } from '@users/dto/user-response.dto';
import { LoginDto } from './dto/login.dto';
import { AuthTokenResult, LoginResponseDto } from './dto/login-response.dto';
import { VARIABLES } from '@common/constants/variables.constants';
import { SUCCESS_MESSAGES } from '@common/constants/success-messages.constants';
import { InvalidCredentialsException } from '@common/exceptions/invalid-credentials.exceptions';
import { SocialOnlyAccountException } from '@common/exceptions/social-only-account.exception';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MailEvent } from 'mail/events/mail.events';
import { UserTokenService } from '@users/token.service';
import { Role, Token } from '@common/types/enums';
import { ResetPasswordDto } from './dto/reset-password.dto';
import * as bcrypt from 'bcrypt';
import { ChangePasswordDto } from './dto/change-password.dto';
import { User } from '@users/entities/user.entity';
import { OAuthCallbackDto } from './dto/oauth-callback.dto';
import { SocialUserProfile } from '@common/types/user-interfaces.type';
import { SocialAuthStrategyFactory } from './social-auth.factory';
import { OAuthStateService } from './oauth-state.service';
import { UnauthorizedException } from '@nestjs/common/exceptions/unauthorized.exception';
import { APP_EVENTS, SecurityAlertPayload } from '@common/events/app.events';

const SELF_REGISTERABLE_ROLES = [Role.CUSTOMER, Role.ARTISAN];

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  constructor(
    private readonly userService: UsersService,
    private readonly emmitter: EventEmitter2,
    private readonly userTokenService: UserTokenService,
    private readonly socialAuthStrategyFactory: SocialAuthStrategyFactory,
    private readonly oauthStateService: OAuthStateService,
  ) {}

  /**
   * Register a new user
   * @param createUserDto - Data Transfer Object for creating a user
   * @returns UserResponseDto - Registered user details
   */
  async registerUser(createUserDto: CreateUserDto): Promise<UserResponseDto> {
    const email = createUserDto.email;
    if (!email) {
      throw new BadRequestException('Provide user email!');
    }
    // G5 fix: CreateUserDto.password is now @IsOptional() (to accurately
    // reflect that AuthService.registerSocialUser()'s social-signup path
    // never supplies one), but THIS public self-registration path must still
    // hard-require a real password — it's the only route to creating an
    // account with no other way to ever sign in (no social provider, no
    // accountVerified-trust precedent). Enforced explicitly here as
    // defense-in-depth now that the DTO-level constraint alone no longer
    // guarantees it. See docs/team/google-oauth-fix/qa-report.md ([MINOR]).
    if (!createUserDto.password) {
      throw new BadRequestException('Provide a password!');
    }

    // S3: public self-registration may only create CUSTOMER or ARTISAN accounts.
    // ADMIN accounts are seed-only and never travel through this validated,
    // publicly-reachable path — silently downgrading a disallowed role would
    // mask the attempt, so we reject it outright instead. `role` omitted
    // entirely is a distinct, legitimate case — default it to CUSTOMER rather
    // than rejecting, per S3's acceptance criteria.
    createUserDto.role = createUserDto.role ?? Role.CUSTOMER;
    if (!SELF_REGISTERABLE_ROLES.includes(createUserDto.role)) {
      this.logger.warn(
        `Rejected self-registration attempt with disallowed role: ${createUserDto.role}`,
      );
      throw new BadRequestException(ERROR_MESSAGES.AUTH.ROLE_NOT_ALLOWED);
    }

    this.logger.log(`Registering User with email ${email}`);

    const existingUser = await this.userService.findUserByEmail(email);
    if (existingUser) {
      throw new UserAlreadyExists(
        ERROR_MESSAGES.USER.EMAIL_ALREADY_EXISTS(email),
      );
    }
    const { data: user } = await this.userService.createUser(createUserDto);
    this.logger.log(`User registered with email ${user.email}`);

    const verificationToken = await this.userTokenService.createToken(
      user,
      Token.EMAIL_VERIFICATION,
      VARIABLES.EMAIL_VERIFICATION_TOKEN_EXPIRES_IN_MINUTES,
    );

    this.emmitter.emit(MailEvent.USER_REGISTERED, {
      email: user.email,
      firstname: user.firstname,
      verificationToken: verificationToken.token,
    });
    this.logger.log(
      `Emitted event for sending registration email to ${user.email}`,
    );
    return plainToInstance(UserResponseDto, user);
  }

  /**
   * Login a user
   * @param loginDto - Data Transfer Object for user login
   * @returns `{ result, refreshToken }` — the controller sets `refreshToken` as an
   *   httpOnly cookie and returns only `result` (which never contains the refresh token).
   */
  async loginUser(loginDto: LoginDto): Promise<AuthTokenResult> {
    const { email, password } = loginDto;
    if (!email || !password) {
      throw new BadRequestException('Provide user email and password!');
    }
    this.logger.log(`Logging in User with email ${email}`);

    const user = await this.userService.findUserByEmail(email);

    if (!user) {
      this.logger.warn(`Invalid credentials provided for email ${email}`);
      throw new InvalidCredentialsException(
        ERROR_MESSAGES.AUTH.INVALID_CREDENTIALS,
      );
    }

    // G10: an account created (or exclusively used) via Google sign-in has no
    // usable password. Detect this BEFORE any bcrypt.compare call and
    // short-circuit with a distinct, specific error — never fold this into
    // the generic invalid-credentials case, and never let a null/placeholder
    // hash reach bcrypt.
    //
    // Efficiency fix: this used to be two independent calls
    // (hasUsablePassword() then validatePassword()), each running its own
    // `SELECT ... WHERE id = ?` for the same password column — an avoidable
    // extra DB round-trip on every single login attempt. Folded into one
    // fetch via getPasswordCheckResult(). See
    // docs/team/google-oauth-fix/qa-report.md ([MINOR]).
    const { hasPassword, isValid } =
      await this.userService.getPasswordCheckResult(password, user.id);

    if (!hasPassword) {
      this.logger.warn(
        `Login blocked for social-only account (no usable password): ${email}`,
      );
      throw new SocialOnlyAccountException(
        ERROR_MESSAGES.AUTH.SOCIAL_ONLY_ACCOUNT,
      );
    }

    if (!isValid) {
      this.logger.warn(`Invalid credentials provided for email ${email}`);
      throw new InvalidCredentialsException(
        ERROR_MESSAGES.AUTH.INVALID_CREDENTIALS,
      );
    }

    // S4: block login until the account's email has been verified. Kept as a
    // distinct 403 (not folded into the generic 401 invalid-credentials error)
    // so the frontend can render a specific "please verify your email" message
    // with a resend-verification path, per the acceptance criteria.
    if (!user.accountVerified) {
      this.logger.warn(`Login blocked for unverified account: ${email}`);
      throw new ForbiddenException(ERROR_MESSAGES.AUTH.EMAIL_NOT_VERIFIED);
    }

    this.logger.log(`Generating tokens for user with email ${email}`);
    const { access_token, refresh_token, expires_at } =
      await this.userTokenService.createJWTTokens(user);
    this.logger.log(`Tokens generated for user with email ${email}`);

    this.logger.log(`User logged in with email ${email}`);
    const result = plainToInstance(LoginResponseDto, {
      access_token,
      expires_at,
      message: SUCCESS_MESSAGES.AUTH.USER_LOGGED_IN,
      data: plainToInstance(UserResponseDto, user),
    });
    return { result, refreshToken: refresh_token };
  }

  /**
   * Verify user email
   * @param token - Email verification token
   * @returns { message: string } - Verification result message
   */
  async verifyEmail(token: string): Promise<void> {
    this.logger.log(`Verifying email with a one-time token`);
    const userToken = await this.userTokenService.validateToken(
      token,
      Token.EMAIL_VERIFICATION,
    );

    if (!userToken) {
      throw new BadRequestException('Invalid or expired token');
    }

    this.logger.log(`Email verified for user with id: ${userToken.id}`);
    userToken.accountVerified = true;
    userToken.verifiedAt = new Date();
    await this.userService.updateUserData(userToken.id, userToken);
    await this.userTokenService.revokeToken(token);
    this.logger.log(
      `Revoked email verification token for user with id: ${userToken.id}`,
    );

    this.emmitter.emit(MailEvent.WELCOME_USER, {
      email: userToken.email,
      firstname: userToken.firstname,
    });
  }

  /**
   * F1: (Re)issues a fresh email-verification token and resends the verification email.
   *
   * Always resolves successfully — whether the email doesn't exist, is already
   * verified, or was just resent — so this endpoint cannot be used to enumerate
   * accounts or their verification state. A short cooldown prevents email spam
   * from repeated rapid calls for the same account.
   *
   * @param email - The account email to resend a verification link to.
   */
  async resendVerification(email: string): Promise<void> {
    this.logger.log(`Processing resend-verification request`);
    const user = await this.userService.findUserByEmail(email);
    if (!user) {
      this.logger.warn(
        `Resend-verification requested for an email with no matching account`,
      );
      return;
    }

    if (user.accountVerified) {
      this.logger.log(
        `Resend-verification requested for an already-verified account: ${user.id}`,
      );
      return;
    }

    const recentToken = await this.userTokenService.getRecentToken(
      user.id,
      Token.EMAIL_VERIFICATION,
    );
    if (recentToken) {
      const secondsSinceIssued =
        (Date.now() - recentToken.createdAt.getTime()) / 1000;
      if (secondsSinceIssued < VARIABLES.RESEND_VERIFICATION_COOLDOWN_SECONDS) {
        this.logger.log(
          `Resend-verification cooldown active for user ${user.id}; skipping resend`,
        );
        return;
      }
    }

    const verificationToken = await this.userTokenService.createToken(
      user,
      Token.EMAIL_VERIFICATION,
      VARIABLES.EMAIL_VERIFICATION_TOKEN_EXPIRES_IN_MINUTES,
    );

    this.emmitter.emit(MailEvent.USER_REGISTERED, {
      email: user.email,
      firstname: user.firstname,
      verificationToken: verificationToken.token,
    });
    this.logger.log(
      `Re-emitted verification email event for user with id: ${user.id}`,
    );
  }

  /**
   * Request a password reset link.
   *
   * Always resolves successfully regardless of whether the email is registered —
   * the controller returns the same generic message either way so this endpoint
   * cannot be used to enumerate registered accounts.
   *
   * @param email - User's email address
   */
  async forgotPassword(email: string): Promise<void> {
    this.logger.log(`Processing forgot password request`);
    const user = await this.userService.findUserByEmail(email);
    if (!user) {
      this.logger.warn(
        `Forgot-password requested for an email with no matching account`,
      );
      return;
    }

    const existingToken =
      await this.userTokenService.getValidPasswordResetToken(user.id);

    if (existingToken) {
      this.logger.log(
        `Reusing existing valid password reset token for user with id: ${user.id}`,
      );
      this.emmitter.emit(MailEvent.PASSWORD_RESET, {
        email: user.email,
        firstname: user.firstname,
        resetToken: existingToken.token,
      });
      return;
    }

    this.logger.log(
      `Creating password reset token for user with id: ${user.id}`,
    );
    const resetToken = await this.userTokenService.createToken(
      user,
      Token.PASSWORD_RESET,
      VARIABLES.PASSWORD_RESET_TOKEN_EXPIRES_IN_MINUTES,
    );
    this.logger.log(
      `Created password reset token for user with id: ${user.id}`,
    );

    this.emmitter.emit(MailEvent.PASSWORD_RESET, {
      email: user.email,
      firstname: user.firstname,
      resetToken: resetToken.token,
    });
    this.logger.log(
      `Emitted event for sending password reset email to ${user.email}`,
    );
  }

  /**
   * Resets the password for a user using a valid password reset token.
   *
   * This method verifies that the provided new password and confirmation match,
   * validates the reset token, hashes the new password, updates the user's record,
   * and revokes the used token. After a successful password reset, it emits an event
   * to notify the user via email.
   *
   * @param token - The password reset token used to verify the user's request.
   * @param resetPasswordDto - The DTO containing the new and confirmed passwords.
   * @throws {BadRequestException} If the passwords do not match or the token is invalid or expired.
   * @returns {Promise<void>} Resolves when the password reset process is complete.
   */
  async resetPassword(
    token: string,
    resetPasswordDto: ResetPasswordDto,
  ): Promise<void> {
    const { newPassword, confirmNewPassword } = resetPasswordDto;
    if (newPassword !== confirmNewPassword) {
      throw new BadRequestException('Passwords do not match');
    }

    this.logger.log(`Resetting password using token ${token}`);
    const user = await this.userTokenService.validateToken(
      token,
      Token.PASSWORD_RESET,
    );
    if (!user) {
      throw new BadRequestException('Invalid or expired token');
    }

    user.password = await bcrypt.hash(newPassword, VARIABLES.SALT_OR_ROUNDS);
    await this.userService.updateUserData(user.id, user);
    this.logger.log(`Password reset successfully for user with id: ${user.id}`);

    await this.userTokenService.revokeToken(token);
    await this.userTokenService.revokeRefreshTokenForUser(user.id);

    this.logger.log(
      `Revoked password reset token and refresh tokens for user with id: ${user.id}`,
    );
    this.emmitter.emit(MailEvent.PASSWORD_RESET_SUCCESS, {
      email: user.email,
      firstname: user.firstname,
    });
    this.logger.log(
      `Emitted event for sending password reset success email to ${user.email}`,
    );
    this.emmitter.emit(APP_EVENTS.SECURITY_ALERT, {
      userId: user.id,
      event: 'PASSWORD_RESET',
    } as SecurityAlertPayload);
  }

  /**
   * Refreshes the user's authentication tokens using a valid refresh token.
   *
   * S5: the presented refresh token is atomically consumed (deleted) as part of
   * validation — `UserTokenService.consumeRefreshToken` removes the row and only
   * then verifies it — so a refresh token can never be redeemed twice. Replaying
   * an already-rotated (or otherwise unknown/expired) refresh token is rejected.
   *
   * @param refreshToken - The refresh token used to authenticate and generate new tokens.
   * @throws {BadRequestException} If the provided refresh token is invalid, unknown, already used, or expired.
   * @returns `{ result, refreshToken }` — the controller sets the new `refreshToken` as an
   *   httpOnly cookie and returns only `result` (which never contains the refresh token).
   */
  async refreshTokens(refreshToken: string): Promise<AuthTokenResult> {
    this.logger.log('Refreshing tokens using refresh token');
    const user = await this.userTokenService.consumeRefreshToken(refreshToken);
    if (!user) {
      throw new BadRequestException(ERROR_MESSAGES.AUTH.INVALID_REFRESH_TOKEN);
    }

    this.logger.log(`Generating new tokens for user with id: ${user.id}`);
    const { access_token, refresh_token, expires_at } =
      await this.userTokenService.createJWTTokens(user);
    this.logger.log(`New tokens generated for user with id: ${user.id}`);

    const result = plainToInstance(LoginResponseDto, {
      access_token,
      expires_at,
      message: SUCCESS_MESSAGES.AUTH.TOKENS_REFRESHED,
      data: plainToInstance(UserResponseDto, user),
    });
    return { result, refreshToken: refresh_token };
  }

  async logout(token: string): Promise<void> {
    this.logger.log('Logging out user and revoking token');
    await this.userTokenService.revokeToken(token);
    this.logger.log('Token revoked successfully');
  }

  async changePassword(
    changePasswordDto: ChangePasswordDto,
    userId: number,
  ): Promise<AuthTokenResult> {
    const user = await this.userService.findUserById(userId);
    if (!user) {
      throw new BadRequestException('User not found');
    }

    const isMatch = await this.userService.validatePassword(
      changePasswordDto.currentPassword,
      userId,
    );
    if (!isMatch) {
      throw new BadRequestException('Current password is incorrect');
    }

    user.password = await bcrypt.hash(
      changePasswordDto.newPassword,
      VARIABLES.SALT_OR_ROUNDS,
    );
    await this.userService.updateUserData(user.id, user);
    this.logger.log(
      `Password changed successfully for user with id: ${user.id}`,
    );

    await this.userTokenService.revokeRefreshTokenForUser(user.id);
    this.logger.log(
      `Revoked existing refresh tokens for user with id: ${user.id} after password change`,
    );
    const { access_token, refresh_token, expires_at } =
      await this.userTokenService.createJWTTokens(user);
    this.logger.log(
      `New tokens generated for user with id: ${user.id} after password change`,
    );

    this.emmitter.emit(MailEvent.PASSWORD_CHANGED, {
      email: user.email,
      firstname: user.firstname,
    });
    this.logger.log(
      `Emitted event for sending password change notification email to ${user.email}`,
    );
    this.emmitter.emit(APP_EVENTS.SECURITY_ALERT, {
      userId: user.id,
      event: 'PASSWORD_CHANGED',
    } as SecurityAlertPayload);

    const result = plainToInstance(LoginResponseDto, {
      access_token,
      expires_at,
      message: SUCCESS_MESSAGES.AUTH.PASSWORD_CHANGED,
      data: plainToInstance(UserResponseDto, user),
    });
    return { result, refreshToken: refresh_token };
  }

  /**
   * G9: normalizes the frontend's `role` query param to a safe signup role.
   * Missing/unrecognized values (and anything other than `artisan`) default
   * to CUSTOMER — this can never produce ADMIN, regardless of input.
   */
  private normalizeSignupRole(role?: string | null): Role {
    return role?.toLowerCase() === 'artisan' ? Role.ARTISAN : Role.CUSTOMER;
  }

  /**
   * Initiate OAuth flow - Redirects user to provider
   * @param provider - Social provider name (google, facebook, github)
   * @param role - G9: raw `role` query param from the signup page's role
   *   toggle (`customer` | `artisan`), normalized and embedded into the CSRF
   *   `state` so it survives the round trip to the provider and back.
   *   Ignored entirely if the callback resolves to an existing account (G6).
   * @returns Authorization URL to redirect to
   */
  initiateOAuthFlow(provider: string, role?: string): Promise<string> {
    this.logger.log(`Initiating OAuth flow for provider: ${provider}`);

    const strategy = this.socialAuthStrategyFactory.getStrategy(provider);

    const signupRole = this.normalizeSignupRole(role);
    const state = this.oauthStateService.generateState(provider, signupRole);
    this.logger.log(`OAuth state generated for ${provider}: ${state}`);
    const authUrl = strategy.getAuthorizationUrl(state);

    this.logger.log(`OAuth authorization URL generated for ${provider}`);
    return Promise.resolve(authUrl);
  }

  /**
   * Handle OAuth callback - Complete the OAuth flow
   * @param provider - Social provider name
   * @param callbackDto - Callback data from provider
   * @returns `{ result, refreshToken }` — the controller sets `refreshToken` as an
   *   httpOnly cookie and returns only `result`, exactly like `loginUser()` (G3).
   */
  async handleOAuthCallback(
    provider: string,
    callbackDto: OAuthCallbackDto,
  ): Promise<AuthTokenResult> {
    const { code, state, error, error_description } = callbackDto;

    // Handle OAuth errors (e.g. the user denied/cancelled Google's consent screen)
    if (error) {
      this.logger.error(
        `OAuth error from ${provider}: ${error} - ${error_description}`,
      );
      throw new UnauthorizedException(
        error_description || `Authentication failed with ${provider}`,
      );
    }

    // Validate (and consume) state for CSRF protection. This also rejects a
    // duplicate/replayed callback hit, since a state can only be consumed once.
    const stateData = this.oauthStateService.consumeState(state, provider);
    if (!stateData) {
      this.logger.error(`Invalid OAuth state for provider: ${provider}`);
      throw new UnauthorizedException('Invalid or expired OAuth state');
    }

    if (!code) {
      this.logger.error(`Missing OAuth authorization code for ${provider}`);
      throw new BadRequestException('Missing OAuth authorization code');
    }

    this.logger.log(`Processing OAuth callback for provider: ${provider}`);

    const strategy = this.socialAuthStrategyFactory.getStrategy(provider);

    const accessToken = await strategy.getAccessToken(code);
    this.logger.log(`Access token obtained from ${provider}`);

    const socialProfile = await strategy.getUserProfile(accessToken);
    this.logger.log(
      `User profile retrieved from ${provider}: ${socialProfile.email}`,
    );

    if (!socialProfile.email) {
      throw new BadRequestException('Email not provided by social provider');
    }

    let user = await this.userService.findUserByEmail(socialProfile.email);

    if (user) {
      // G6: an existing account is found by email — the role param (if any)
      // is ignored entirely; it can only ever affect a brand-new account.
      user = await this.updateSocialLoginInfo(user, socialProfile);
    } else {
      user = await this.registerSocialUser(socialProfile, stateData.role);
    }

    this.logger.log(`Generating tokens for social login user: ${user.email}`);
    const { access_token, refresh_token, expires_at } =
      await this.userTokenService.createJWTTokens(user);

    this.logger.log(`Social login successful for user: ${user.email}`);

    const result = plainToInstance(LoginResponseDto, {
      access_token,
      expires_at,
      message: SUCCESS_MESSAGES.AUTH.USER_LOGGED_IN,
      data: plainToInstance(UserResponseDto, user),
    });
    return { result, refreshToken: refresh_token };
  }

  /**
   * Register a new user from social provider - PRIVATE HELPER
   * @param role - G9: the intended signup role, already normalized by
   *   `initiateOAuthFlow`/`normalizeSignupRole`. Re-normalized here as a
   *   defense-in-depth guard so this method can never produce an ADMIN
   *   account regardless of what reaches it.
   */
  private async registerSocialUser(
    socialProfile: SocialUserProfile,
    role?: Role,
  ): Promise<User> {
    this.logger.log(`Registering new social user: ${socialProfile.email}`);

    const safeRole = role === Role.ARTISAN ? Role.ARTISAN : Role.CUSTOMER;

    const createUserDto = plainToInstance(CreateUserDto, {
      email: socialProfile.email,
      firstname: socialProfile.firstname,
      lastname: socialProfile.lastname,
      profilePicture: socialProfile.profilePicture,
      socialProvider: socialProfile.provider,
      socialProviderId: socialProfile.providerId,
      isSocialLogin: true,
      role: safeRole,
      // G5: no `password`/`gender` — Google never supplies either, and both
      // columns are nullable via migration so account creation no longer
      // crashes. `password` stays null until the user sets a real one via
      // change-password or the forgot/reset-password flow (G10).
    });

    const { data: user } = await this.userService.createUser(createUserDto);

    // G10 fix: Google already verifies the account's email address as a
    // condition of returning it in the OAuth profile, so trust it here —
    // consistent with G6's existing trust-Google's-verified-email precedent.
    // Deliberately NOT added as a settable field on CreateUserDto: that DTO
    // is also bound to the public self-registration endpoint, and exposing
    // an `accountVerified` override there would let a normal signup skip
    // email verification entirely. Set it via a direct follow-up update
    // instead, and keep the returned `user` object in sync so the rest of
    // this request (e.g. the response DTO) reflects it too.
    //
    // Without this, a Google-only account has no DB default for
    // `accountVerified` (lands `null`) and is never routed through
    // verifyEmail() (no verification token/email is ever created for a
    // social signup) — so even after the user later sets a real password
    // via Forgot Password, email/password login would remain permanently
    // blocked by the unrelated S4 "email not verified" gate. See
    // docs/team/google-oauth-fix/qa-report.md (BLOCKER) and
    // security-report.md ([HIGH]).
    const verifiedAt = new Date();
    await this.userService.updateUserData(user.id, {
      accountVerified: true,
      verifiedAt,
    });
    user.accountVerified = true;
    user.verifiedAt = verifiedAt;

    this.logger.log(`Social user registered: ${user.email}`);

    this.emmitter.emit(MailEvent.SOCIAL_USER_REGISTERED, {
      email: user.email,
      firstname: user.firstname,
      provider: socialProfile.provider,
    });

    return user;
  }

  /**
   * Update existing user with social login info - PRIVATE HELPER
   */
  private async updateSocialLoginInfo(
    user: User,
    socialProfile: SocialUserProfile,
  ): Promise<User> {
    // Only update if not already a social user or if profile picture is missing
    if (!user.isSocialLogin || !user.profilePicture) {
      // Fixed: this write used to be fire-and-forget (no await, no .catch()).
      // handleOAuthCallback() resolved (tokens issued, login "succeeds")
      // before this settled, so a real rejection (DB blip, deadlock, etc.)
      // became an unhandled promise rejection — which crashes the entire
      // Node process by default (verified against this project's Node 22
      // runtime), taking the whole API down for every user on any existing
      // user's Google re-login, not just the one mid-login. Now awaited and
      // log-and-swallowed: a failure here is a non-fatal profile-sync
      // hiccup, never something that should block login or crash the
      // process. See docs/team/google-oauth-fix/qa-report.md ([MAJOR]) and
      // security-report.md ([LOW]).
      try {
        await this.userService.updateUserData(user.id, {
          socialProvider: socialProfile.provider,
          socialProviderId: socialProfile.providerId,
          isSocialLogin: true,
          profilePicture: user.profilePicture || socialProfile.profilePicture,
        });
      } catch (err) {
        this.logger.warn(
          `Non-fatal: failed to sync social login profile info for user ${user.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return user;
  }
}
