import { BadRequestException, Injectable , Logger} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ERROR_MESSAGES } from '@common/constants/error-messages.constants';
import { UserAlreadyExists } from '@common/exceptions/user-already-exists.exception';
import { CreateUserDto } from '@users/dto/create-user.dto';
import { UsersService } from '@users/users.service';
import { plainToInstance } from 'class-transformer';
import { UserResponseDto } from '@users/dto/user-response.dto';
import { LoginDto } from './dto/login.dto';
import { LoginResponseDto } from './dto/login-response.dto';
import { VARIABLES } from '@common/constants/variables.constants';
import { InvalidCredentialsException } from '@common/exceptions/invalid-credentials.exceptions';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MailEvent } from 'mail/events/mail.events';
import { UserTokenService } from '@users/token.service';
import { Token } from '@common/types/enums';
import { ResetPasswordDto } from './dto/reset-password.dto';
import * as bcrypt from 'bcrypt';


@Injectable()
export class AuthService {
    private readonly logger = new Logger(AuthService.name);
    constructor(
        private readonly userService: UsersService,
        private readonly jwtService: JwtService,
        private readonly emmitter: EventEmitter2,
        private readonly userTokenService: UserTokenService,
    ){}

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
        user = await this.userService.createUser(createUserDto);
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
        const { access_token, refresh_token } = this.createTokens(user.id, user.email, user.role);


        this.logger.log(`User logged in with email ${email}`);
        return plainToInstance(LoginResponseDto, {
            access_token,
            refresh_token,
            message: VARIABLES.USER_LOGGED_IN,
            data: plainToInstance(UserResponseDto, user)
        });

    }

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
        this.logger.log(`Revoked password reset token for user with id: ${user.id}`);
        this.emmitter.emit(MailEvent.PASSWORD_RESET_SUCCESS, {
            email: user.email,
            firstname: user.firstname,
        });
        this.logger.log(`Emitted event for sending password reset success email to ${user.email}`);
    }


    createTokens(userId: number, email: string, role: string) {
        const payload = { sub: userId, email, role };
        const access_token = this.jwtService.sign(payload, { expiresIn: process.env.JWT_ACCESS_EXPIRES_IN });
        const refresh_token = this.jwtService.sign(payload, { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN });

        return { access_token, refresh_token };
    }

}
