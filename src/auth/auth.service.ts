import { BadRequestException, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { create } from 'domain';
import { ERROR_MESSAGES } from 'src/common/constants/error-messages.constants';
import { UserAlreadyExists } from 'src/common/exceptions/user-already-exists.exception';
import { CreateUserDto } from 'src/users/dto/create-user.dto';
import { User } from 'src/users/entities/user.entity';
import { UsersService } from 'src/users/users.service';

@Injectable()
export class AuthService {
    constructor(
        private userService: UsersService,
        private jwtService: JwtService,
    ){}

    async registerUser(createUserDto: CreateUserDto): Promise<User>{
        let user;
        const email = createUserDto.email;
        if(!email){
            throw new BadRequestException("Provide user email!");
        }

        user = await this.userService.findUserByEmail(email);
        if(user){
            throw new UserAlreadyExists(ERROR_MESSAGES.USER.EMAIL_ALREADY_EXISTS(email))
        }
        user = await this.userService.createUser(createUserDto);
        if(!user) {
            throw
        }
        return user;
    }
}
