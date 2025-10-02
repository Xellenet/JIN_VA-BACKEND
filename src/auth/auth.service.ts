import { BadRequestException, Injectable , Logger} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ERROR_MESSAGES } from '@common/constants/error-messages.constants';
import { UserAlreadyExists } from '@common/exceptions/user-already-exists.exception';
import { CreateUserDto } from '@users/dto/create-user.dto';
import { UsersService } from '@users/users.service';
import { plainToInstance } from 'class-transformer';
import { UserResponseDto } from '@users/dto/user-response.dto';

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
}
