import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { User } from './entities/user.entity';
import { In, Repository } from 'typeorm';
import { UserAlreadyExists } from '@common/exceptions/user-already-exists.exception';
import { ERROR_MESSAGES } from '@common/constants/error-messages.constants';
import * as bcrypt from 'bcrypt';
import { VARIABLES } from '@common/constants/variables.constants';
import { ArtisanProfile } from './entities/artisan-profile.entity';
import { CustomerProfile } from './entities/customer-profile.entity';
import { UpdateArtisanProfileDto } from './dto/update-artisan-profile.dto';
import { UpdateCustomerProfileDto } from './dto/update-customer-profile.dto';
import { Role } from '@common/types/enums';
import { plainToInstance } from 'class-transformer';
import { ArtisanProfileResponseDto } from './dto/artisan-profile-response.dto';
import { CustomerProfileResponseDto } from './dto/customer-profile-response.dto';
import { ServiceEntity } from '@services/entities/service.entity';


@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(ArtisanProfile)
    private readonly artisanProfilesRepository: Repository<ArtisanProfile>,
    @InjectRepository(CustomerProfile)
    private readonly customerProfilesRepository: Repository<CustomerProfile>,
    @InjectRepository(ServiceEntity)
    private readonly servicesRepository: Repository<ServiceEntity>,
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
    const hashedPassword = await bcrypt.hash(createUserDto.password, VARIABLES.SALT_OR_ROUNDS);
    user = this.usersRepository.create(
      {
        ...createUserDto,
        password: hashedPassword,
      }
    );

    this.logger.log(`Created user with id: ${user.id}`);

    const savedUser = await this.usersRepository.save(user);

    if (savedUser.role === Role.ARTISAN) {
      const artisanProfile = this.artisanProfilesRepository.create({
        user: savedUser,
        bio: '',
        experienceYears: undefined,
        hourlyRate: undefined,
        businessName: '',
        averageRating: 0,
        totalReviews: 0,
        availabilityStatus: 'AVAILABLE',
        services: [],
      });
      await this.artisanProfilesRepository.save(artisanProfile);
    }

    if (savedUser.role === Role.CUSTOMER) {
      const customerProfile = this.customerProfilesRepository.create({
        user: savedUser,
        bio: '',
        preferredServices: [],
        budgetMin: undefined,
        budgetMax: undefined,
      });
      await this.customerProfilesRepository.save(customerProfile);
    }

    return savedUser;
  }

  async findUserById(id: number): Promise<User | null>{
    if(!id){
      throw new NotFoundException("User ID required")
    }

    this.logger.log(`Finding user with id ${id}`);
    const user = await this.usersRepository.findOne({
      where: {id},
    })
    return user;
  }

  async findUserByEmail(email: string): Promise<User | null>{
    if(!email){
      throw new NotFoundException("Email required")
    }

    this.logger.log(`Finding user with email ${email}`);
    const user = await this.usersRepository.findOne({
      where: {email},
    })
    return user;
  }

  async  validatePassword(password: string, userId: number): Promise<boolean> {
    const user = await this.usersRepository.findOne({
      where: {id: userId},
      select: ['password'],
    });
    if (!user) {
      throw new NotFoundException(`User with ID ${userId} not found `);
    }
    const isPasswordValid = await bcrypt.compare(password, user.password);
    return  isPasswordValid;
  }

  async findOne(id: number) {
    return await this.usersRepository.findOne({
      where: {id},
      select: ['password']
    });
  }

  async updateUser(id: number, updateUserDto: UpdateUserDto) {
    await this.usersRepository.update(id, updateUserDto);
    this.logger.log(`Updated user with id: ${id}`);
    return this.findOne(id);
  }


  async updateUserData(id: number, user: Partial<User>) {
    await this.usersRepository.update(id, user);
    this.logger.log(`Updated user data for user with id: ${id}`);
  }

  async remove(id: number) {
    await this.usersRepository.delete(id);
    this.logger.log(`Removed user with id: ${id}`);
  }

  async findArtisanProfileByUserId(userId: number): Promise<ArtisanProfileResponseDto> {
    const profile = await this.artisanProfilesRepository.findOne({
      where: { user: { id: userId } },
      relations: ['user', 'user.addresses', 'services'],
    });

    if (!profile) {
      throw new NotFoundException(`Artisan profile for user id ${userId} not found`);
    }

    return this.toArtisanProfileResponse(profile);
  }

  async updateArtisanProfile(
    userId: number,
    updateArtisanProfileDto: UpdateArtisanProfileDto,
  ): Promise<ArtisanProfileResponseDto> {
    const { serviceIds, ...profileUpdates } = updateArtisanProfileDto;
    
    const profile = await this.artisanProfilesRepository.findOne({
      where: { user: { id: userId } },
      relations: ['user', 'user.addresses', 'services'],
    });

    if (!profile) {
      throw new NotFoundException(`Artisan profile for user id ${userId} not found`);
    }

    if (serviceIds !== undefined) {
      if (serviceIds.length === 0) {
        profile.services = [];
      } else {
        const services = await this.servicesRepository.findBy({
          id: In(serviceIds),
        });
        
        if (services.length !== serviceIds.length) {
          throw new NotFoundException('One or more services were not found.');
        }
        
        profile.services = services;
      }
    }

    Object.assign(profile, profileUpdates);
    await this.artisanProfilesRepository.save(profile);
    return this.findArtisanProfileByUserId(userId);
  }

  async findCustomerProfileByUserId(userId: number): Promise<CustomerProfileResponseDto> {
    const profile = await this.customerProfilesRepository.findOne({
      where: { user: { id: userId } },
      relations: ['user', 'user.addresses', 'preferredServices'],
    });

    if (!profile) {
      throw new NotFoundException(`Customer profile for user id ${userId} not found`);
    }

    return this.toCustomerProfileResponse(profile);
  }

  async updateCustomerProfile(
    userId: number,
    updateCustomerProfileDto: UpdateCustomerProfileDto,
  ): Promise<CustomerProfileResponseDto> {
    const { preferredServiceIds, ...profileUpdates } = updateCustomerProfileDto;
    
    const profile = await this.customerProfilesRepository.findOne({
      where: { user: { id: userId } },
      relations: ['user', 'user.addresses', 'preferredServices'],
    });

    if (!profile) {
      throw new NotFoundException(`Customer profile for user id ${userId} not found`);
    }

    const nextBudgetMin =
      updateCustomerProfileDto.budgetMin === undefined
        ? profile.budgetMin
        : updateCustomerProfileDto.budgetMin;
    const nextBudgetMax =
      updateCustomerProfileDto.budgetMax === undefined
        ? profile.budgetMax
        : updateCustomerProfileDto.budgetMax;

    if (
      nextBudgetMin !== undefined &&
      nextBudgetMax !== undefined &&
      Number(nextBudgetMax) < Number(nextBudgetMin)
    ) {
      throw new BadRequestException('budgetMax must be greater than or equal to budgetMin.');
    }

    if (preferredServiceIds !== undefined) {
      if (preferredServiceIds.length === 0) {
        profile.preferredServices = [];
      } else {
        const preferredServices = await this.servicesRepository.findBy({
          id: In(preferredServiceIds),
        });
        
        if (preferredServices.length !== preferredServiceIds.length) {
          throw new NotFoundException('One or more preferred services were not found.');
        }
        
        profile.preferredServices = preferredServices;
      }
    }

    Object.assign(profile, profileUpdates);
    await this.customerProfilesRepository.save(profile);
    return this.findCustomerProfileByUserId(userId);
  }

  private toArtisanProfileResponse(profile: ArtisanProfile): ArtisanProfileResponseDto {
    return plainToInstance(ArtisanProfileResponseDto, profile, {
      excludeExtraneousValues: true,
    });
  }

  private toCustomerProfileResponse(profile: CustomerProfile): CustomerProfileResponseDto {
    return plainToInstance(CustomerProfileResponseDto, profile, {
      excludeExtraneousValues: true,
    });
  }
}
