import { BadRequestException, Injectable , Logger} from '@nestjs/common';
import { ERROR_MESSAGES } from '@common/constants/error-messages.constants';
import { UserAlreadyExists } from '@common/exceptions/user-already-exists.exception';
import { CreateUserDto } from '@users/dto/create-user.dto';
import { UsersService } from '@users/users.service';
import { plainToInstance } from 'class-transformer';
import { UserResponseDto } from '@users/dto/user-response.dto';
import { LoginDto } from './dto/login.dto';
import { LoginResponseDto } from './dto/login-response.dto';
import { VARIABLES } from '@common/constants/variables.constants';
import { SUCCESS_MESSAGES } from '@common/constants/success-messages.constants';
import { InvalidCredentialsException } from '@common/exceptions/invalid-credentials.exceptions';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MailEvent } from 'mail/events/mail.events';
import { UserTokenService } from '@users/token.service';
import { Token } from '@common/types/enums';
import { ResetPasswordDto } from './dto/reset-password.dto';
import * as bcrypt from 'bcrypt';
import { ChangePasswordDto } from './dto/change-password.dto';
import { User } from '@users/entities/user.entity';
import { OAuthCallbackDto } from './dto/oauth-callback.dto';
import { SocialUserProfile } from '@common/types/user-interfaces.type';
import { SocialAuthStrategyFactory } from './social-auth.factory';
import { OAuthStateService } from './oauth-state.service';
import { UnauthorizedException } from '@nestjs/common/exceptions/unauthorized.exception';


@Injectable()
export class AuthService {
    private readonly logger = new Logger(AuthService.name);
    constructor(
        private readonly userService: UsersService,
        private readonly emmitter: EventEmitter2,
        private readonly userTokenService: UserTokenService,
        private readonly socialAuthStrategyFactory: SocialAuthStrategyFactory,
        private readonly oauthStateService: OAuthStateService,
        
    ){}

    /**
     * Register a new user
     * @param createUserDto - Data Transfer Object for creating a user
     * @returns UserResponseDto - Registered user details
     */
    async registerUser(createUserDto: CreateUserDto): Promise<UserResponseDto>{
        let user;
        const email = createUserDto.email;
        if(!email){
            throw new BadRequestException("Provide user email!");
        }
        this.logger.log(`Registering User with email ${email}`);

        user = await this.userService.findUserByEmail(email);
        if(user){
            throw new UserAlreadyExists(ERROR_MESSAGES.USER.EMAIL_ALREADY_EXISTS(email))
        }
        const { data: createdUser } = await this.userService.createUser(createUserDto);
        user = createdUser;
        this.logger.log(`User registered with email ${user.email}`);

        const verificationToken = await this.userTokenService.createToken(
            user,
            Token.EMAIL_VERIFICATION,
            VARIABLES.EMAIL_VERIFICATION_TOKEN_EXPIRES_IN_MINUTES
        );


        this.emmitter.emit(MailEvent.USER_REGISTERED, {
            email: user.email,
            firstname: user.firstname,
            verificationToken: verificationToken.token,
        });
        this.logger.log(`Emitted event for sending registration email to ${user.email}`);
        return plainToInstance(UserResponseDto, user);

    }

    /**
     * Login a user
     * @param loginDto - Data Transfer Object for user login
     * @returns LoginResponseDto - Logged in user details
     */
    async loginUser(loginDto: LoginDto): Promise<LoginResponseDto> {
        let user;
        const { email, password } = loginDto;
        if(!email || !password){
            throw new BadRequestException("Provide user email and password!");
        }
        this.logger.log(`Logging in User with email ${email}`);

        user = await this.userService.findUserByEmail(email);

        if(!user || !(await this.userService.validatePassword(password, user.id))){
            this.logger.warn(`Invalid credentials provided for email ${email}`);
            throw new InvalidCredentialsException(ERROR_MESSAGES.AUTH.INVALID_CREDENTIALS);
        }

        this.logger.log(`Generating tokens for user with email ${email}`);
        const { access_token, refresh_token, expires_at } = await this.userTokenService.createJWTTokens(user);
        this.logger.log(`Tokens generated for user with email ${email}`);


        this.logger.log(`User logged in with email ${email}`);
        return plainToInstance(LoginResponseDto, {
            access_token,
            refresh_token,
            expires_at,
            message: SUCCESS_MESSAGES.AUTH.USER_LOGGED_IN,
            data: plainToInstance(UserResponseDto, user)
        });

    }

    /**
     * Verify user email
     * @param token - Email verification token
     * @returns { message: string } - Verification result message
     */
    async verifyEmail(token: string): Promise<void> {
        this.logger.log(`Verifying email with token ${token}`);
        const userToken = await this.userTokenService.validateToken(token, Token.EMAIL_VERIFICATION);

        if (!userToken) {
            throw new BadRequestException("Invalid or expired token");
        }
        
        this.logger.log(`Email verified for user with id: ${userToken.id}`);
        userToken.accountVerified = true;
        userToken.verifiedAt = new Date();
        await this.userService.updateUserData(userToken.id, userToken);
        await this.userTokenService.revokeToken(token);
        this.logger.log(`Revoked email verification token for user with id: ${userToken.id}`);

        this.emmitter.emit(MailEvent.WELCOME_USER, {
            email: userToken.email,
            firstname: userToken.firstname
        });
    }

    /**
     * Request a password reset link
     * @param email - User's email address
     * @returns { message: string } - Success message
     */
    async forgotPassword(email: string): Promise<void> {
        this.logger.log(`Processing forgot password for email ${email}`);
        const user = await this.userService.findUserByEmail(email);
        if (!user) {
            this.logger.warn(`No user found with email ${email}`);
            throw new BadRequestException(ERROR_MESSAGES.USER.NOT_FOUND_WITH_EMAIL(email));
        }
        
        const existingToken = await this.userTokenService.getValidPasswordResetToken(user.id);

        if (existingToken) {
            this.logger.log(`Reusing existing valid password reset token for user with id: ${user.id}`);
            this.emmitter.emit(MailEvent.PASSWORD_RESET, {
            email: user.email,
            firstname: user.firstname,
            resetToken: existingToken.token,
        });
            return;
        }

        this.logger.log(`Creating password reset token for user with id: ${user.id}`);
        const resetToken = await this.userTokenService.createToken(
            user,
            Token.PASSWORD_RESET,
            VARIABLES.PASSWORD_RESET_TOKEN_EXPIRES_IN_MINUTES
        );
        this.logger.log(`Created password reset token for user with id: ${user.id}`);

        this.emmitter.emit(MailEvent.PASSWORD_RESET, {
            email: user.email,
            firstname: user.firstname,
            resetToken: resetToken.token,
        });
        this.logger.log(`Emitted event for sending password reset email to ${user.email}`);
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
    async resetPassword(token: string, resetPasswordDto: ResetPasswordDto): Promise<void> {
        const { newPassword, confirmNewPassword } = resetPasswordDto;
        if (newPassword !== confirmNewPassword) {
            throw new BadRequestException("Passwords do not match");
        }

        this.logger.log(`Resetting password using token ${token}`);
        const user = await this.userTokenService.validateToken(token, Token.PASSWORD_RESET);
        if (!user) {
            throw new BadRequestException("Invalid or expired token");
        }

        user.password = await bcrypt.hash(newPassword, VARIABLES.SALT_OR_ROUNDS);
        await this.userService.updateUserData(user.id, user);
        this.logger.log(`Password reset successfully for user with id: ${user.id}`);

        await this.userTokenService.revokeToken(token);
        await this.userTokenService.revokeRefreshTokenForUser(user.id);

        this.logger.log(`Revoked password reset token and refresh tokens for user with id: ${user.id}`);
        this.emmitter.emit(MailEvent.PASSWORD_RESET_SUCCESS, {
            email: user.email,
            firstname: user.firstname,
        });
        this.logger.log(`Emitted event for sending password reset success email to ${user.email}`);
    }



    /**
     * Refreshes the user's authentication tokens using a valid refresh token.
     *
     * This method validates the provided refresh token, generates new access and
     * refresh tokens for the user, and returns them along with user details in
     * a structured response object.
     *
     * @param refreshToken - The refresh token used to authenticate and generate new tokens.
     * @throws {BadRequestException} If the provided refresh token is invalid or expired.
     * @returns {Promise<LoginResponseDto>} An object containing the new access and refresh tokens,
     * a success message, and the user's information.
     */

    async refreshTokens(refreshToken: string): Promise<LoginResponseDto> {
        this.logger.log('Refreshing tokens using refresh token ');
        this.logger.log(`Provided refresh token: ${refreshToken}`);
        const user = await this.userTokenService.validateToken(refreshToken, Token.REFRESH);
        if (!user) {
            throw new BadRequestException("Invalid or expired refresh token");
        }

        this.logger.log(`Generating new tokens for user with id: ${user.id}`);
        const { access_token, refresh_token, expires_at } = await this.userTokenService.createJWTTokens(user);
        this.logger.log(`New tokens generated for user with id: ${user.id}`);

        return plainToInstance(LoginResponseDto, {
            access_token,
            refresh_token,
            expires_at,
            message: SUCCESS_MESSAGES.AUTH.TOKENS_REFRESHED,
            data: plainToInstance(UserResponseDto, user)
        });
    }

    async logout(token: string): Promise<void> {
        this.logger.log('Logging out user and revoking token');
        await this.userTokenService.revokeToken(token);
        this.logger.log('Token revoked successfully');
    }

    async changePassword(changePasswordDto: ChangePasswordDto, userId: number): Promise<LoginResponseDto>{
        const user = await this.userService.findUserById(userId);
        if (!user) {
            throw new BadRequestException("User not found");
        }

        const isMatch = await this.userService.validatePassword(changePasswordDto.currentPassword, userId);
        if (!isMatch) {
            throw new BadRequestException("Current password is incorrect");
        }

        user.password = await bcrypt.hash(changePasswordDto.newPassword, VARIABLES.SALT_OR_ROUNDS);
        await this.userService.updateUserData(user.id, user);
        this.logger.log(`Password changed successfully for user with id: ${user.id}`);

        await this.userTokenService.revokeRefreshTokenForUser(user.id);
        this.logger.log(`Revoked existing refresh tokens for user with id: ${user.id} after password change`);
        const { access_token, refresh_token, expires_at } = await this.userTokenService.createJWTTokens(user);
        this.logger.log(`New tokens generated for user with id: ${user.id} after password change`);

        this.emmitter.emit(MailEvent.PASSWORD_CHANGED, {
            email: user.email,
            firstname: user.firstname,
        });
        this.logger.log(`Emitted event for sending password change notification email to ${user.email}`);

        return plainToInstance(LoginResponseDto, {
            access_token,
            refresh_token,
            expires_at,
            message: SUCCESS_MESSAGES.AUTH.PASSWORD_CHANGED,
            data: plainToInstance(UserResponseDto, user)
        });
    }


    /**
   * Initiate OAuth flow - Redirects user to provider
   * @param provider - Social provider name (google, facebook, github)
   * @returns Authorization URL to redirect to
   */
  async initiateOAuthFlow(provider: string): Promise<string> {
    this.logger.log(`Initiating OAuth flow for provider: ${provider}`);

    const strategy = this.socialAuthStrategyFactory.getStrategy(provider);
    
    const state = this.oauthStateService.generateState(provider);
    this.logger.log(`OAuth state generated for ${provider}: ${state}`);
    const authUrl = strategy.getAuthorizationUrl(state);
    
    this.logger.log(`OAuth authorization URL generated for ${provider}`);
    return authUrl;
  }

  /**
   * Handle OAuth callback - Complete the OAuth flow
   * @param provider - Social provider name
   * @param callbackDto - Callback data from provider
   * @returns Login response with tokens
   */
  async handleOAuthCallback(
    provider: string,
    callbackDto: OAuthCallbackDto,
  ): Promise<LoginResponseDto> {
    const { code, state, error, error_description } = callbackDto;

    // Handle OAuth errors
    if (error) {
      this.logger.error(`OAuth error from ${provider}: ${error} - ${error_description}`);
      throw new UnauthorizedException(
        error_description || `Authentication failed with ${provider}`,
      );
    }

    // Validate state for CSRF protection
    if (!this.oauthStateService.validateState(state, provider)) {
      this.logger.error(`Invalid OAuth state for provider: ${provider}`);
      throw new UnauthorizedException('Invalid or expired OAuth state');
    }

    this.logger.log(`Processing OAuth callback for provider: ${provider}`);

    const strategy = this.socialAuthStrategyFactory.getStrategy(provider);

    const accessToken = await strategy.getAccessToken(code);
    this.logger.log(`Access token obtained from ${provider}`);

    const socialProfile = await strategy.getUserProfile(accessToken);
    this.logger.log(`User profile retrieved from ${provider}: ${socialProfile.email}`);

    if (!socialProfile.email) {
      throw new BadRequestException('Email not provided by social provider');
    }

    let user = await this.userService.findUserByEmail(socialProfile.email);

    if (user) {
      user = await this.updateSocialLoginInfo(user, socialProfile);
    } else {
      user = await this.registerSocialUser(socialProfile);
    }

    this.logger.log(`Generating tokens for social login user: ${user.email}`);
    const { access_token, refresh_token, expires_at } = await this.userTokenService.createJWTTokens(user);

    this.logger.log(`Social login successful for user: ${user.email}`);

    return plainToInstance(LoginResponseDto, {
      access_token,
      refresh_token,
      expires_at,
      message: SUCCESS_MESSAGES.AUTH.USER_LOGGED_IN,
      data: plainToInstance(UserResponseDto, user),
    });
  }

  /**
   * Register a new user from social provider - PRIVATE HELPER
   */
  private async registerSocialUser(socialProfile: SocialUserProfile): Promise<User> {
    this.logger.log(`Registering new social user: ${socialProfile.email}`);

      const createUserDto = plainToInstance(CreateUserDto, {
    email: socialProfile.email,
    firstname: socialProfile.firstname,
    lastname: socialProfile.lastname,
    profilePicture: socialProfile.profilePicture,
    socialProvider: socialProfile.provider,
    socialProviderId: socialProfile.providerId,
    isSocialLogin: true,
  });

    const { data: user } = await this.userService.createUser(createUserDto);

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
        this.userService.updateUserData(user.id, {
        socialProvider: socialProfile.provider,
        socialProviderId: socialProfile.providerId,
        isSocialLogin: true,
        profilePicture: user.profilePicture || socialProfile.profilePicture,
      });
    }
    return user;
  }

}
