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


@Injectable()
export class AuthService {
    private readonly logger = new Logger(AuthService.name);
    constructor(
        private readonly userService: UsersService,
        private readonly jwtService: JwtService,
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

    createTokens(userId: number, email: string, role: string) {
        const payload = { sub: userId, email, role };
        const access_token = this.jwtService.sign(payload, { expiresIn: process.env.JWT_ACCESS_EXPIRES_IN });
        const refresh_token = this.jwtService.sign(payload, { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN });

        return { access_token, refresh_token };
    }

}
