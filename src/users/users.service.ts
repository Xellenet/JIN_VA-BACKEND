import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { User } from './entities/user.entity';
import { Repository } from 'typeorm';
import { UserAlreadyExists } from '@common/exceptions/user-already-exists.exception';
import { ERROR_MESSAGES } from '@common/constants/error-messages.constants';
import * as bcrypt from 'bcrypt';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
  ) {}
  async createUser(createUserDto: CreateUserDto): Promise<User> {
    let user;
    const email = createUserDto.email;
    if(!email) {
      throw new BadRequestException("Provide User Email!")
    }

    user = await this.findUserByEmail(email);
    if(user){
      throw new UserAlreadyExists(ERROR_MESSAGES.USER.EMAIL_ALREADY_EXISTS(email))
    }
    const hashedPassword = await bcrypt.hash(createUserDto.password, 12);
    user = this.usersRepository.create(
      {
        ...createUserDto,
        password: hashedPassword,
      }
    );

    this.logger.log(`Created user with id: ${user.id}`);
    return this.usersRepository.save(user);
  }

  async findUser() {
    this.logger.log(`Retrieving all users`);
    const users = await this.usersRepository.find();

    return users;
  }

  async findUserByEmail(email: string): Promise<User | null>{
    if(!email){
      throw new NotFoundException("Email required")
    }

    this.logger.log(`Finding user with email ${email}`);
    const user = await this.usersRepository.findOne({
      where: {email},
    })
    // if(!user) {
    //   throw new UserNotFoundException(`User with email ${email} not found`)
    // }
    return user;
  }
  findOne(id: number) {
    return `This action returns a #${id} user`;
  }

  update(id: number, updateUserDto: UpdateUserDto) {
    return `This action updates a #${id} user`;
  }

  remove(id: number) {
    return `This action removes a #${id} user`;
  }
}
