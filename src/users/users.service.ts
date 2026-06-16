import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdateMeDto } from './dto/update-me.dto';
import { UserResponseDto } from './dto/user-response.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { User } from './entities/user.entity';
import { In, Repository } from 'typeorm';
import { UserAlreadyExists } from '@common/exceptions/user-already-exists.exception';
import { ERROR_MESSAGES } from '@common/constants/error-messages.constants';
import { SUCCESS_MESSAGES } from '@common/constants/success-messages.constants';
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

  /**
   * Creates a new user account and auto-provisions the matching role profile
   * (artisan or customer). Password is bcrypt-hashed before persistence.
   *
   * @param createUserDto - Required fields for the new user.
   * @returns `{ message, data: User }` — callers that need the raw `User` entity
   *   (e.g. `AuthService`) should destructure: `const { data: user } = await createUser(dto)`.
   * @throws {BadRequestException} When no email is provided.
   * @throws {UserAlreadyExists} When a user with the same email already exists.
   */
  async createUser(createUserDto: CreateUserDto): Promise<{ message: string; data: User }> {
    let user;
    const email = createUserDto.email;
    if (!email) {
      throw new BadRequestException('Provide User Email!');
    }

    user = await this.findUserByEmail(email);
    if (user) {
      throw new UserAlreadyExists(ERROR_MESSAGES.USER.EMAIL_ALREADY_EXISTS(email));
    }
    const hashedPassword = await bcrypt.hash(createUserDto.password, VARIABLES.SALT_OR_ROUNDS);
    user = this.usersRepository.create({ ...createUserDto, password: hashedPassword });

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

    return { message: SUCCESS_MESSAGES.USER.CREATED, data: savedUser };
  }

  /**
   * Returns the full profile of the authenticated user, including their addresses.
   *
   * @param userId - The ID of the authenticated user (from `req.user.id`).
   * @returns `{ message, data: UserResponseDto }` with addresses populated.
   * @throws {NotFoundException} When no user with the given ID exists.
   */
  async findMe(userId: number): Promise<{ message: string; data: UserResponseDto }> {
    const user = await this.usersRepository.findOne({
      where: { id: userId },
      relations: ['addresses'],
    });

    if (!user) {
      throw new NotFoundException(`User with ID ${userId} not found`);
    }

    return {
      message: SUCCESS_MESSAGES.USER.RETRIEVED,
      data: plainToInstance(UserResponseDto, user, { excludeExtraneousValues: true }),
    };
  }

  /**
   * Applies a partial update to the authenticated user's own base profile.
   * Email, password, and role changes are intentionally excluded — they each
   * require dedicated, security-sensitive flows.
   *
   * @param userId - The ID of the authenticated user (from `req.user.id`).
   * @param updateMeDto - Fields to update (all optional).
   * @returns `{ message, data: UserResponseDto }` reflecting the saved state.
   * @throws {NotFoundException} When no user with the given ID exists.
   */
  async updateMe(userId: number, updateMeDto: UpdateMeDto): Promise<{ message: string; data: UserResponseDto }> {
    const user = await this.usersRepository.findOne({
      where: { id: userId },
      relations: ['addresses'],
    });

    if (!user) {
      throw new NotFoundException(`User with ID ${userId} not found`);
    }

    Object.assign(user, updateMeDto);
    const saved = await this.usersRepository.save(user);
    this.logger.log(`User ${userId} updated their own profile`);

    return {
      message: SUCCESS_MESSAGES.USER.UPDATED,
      data: plainToInstance(UserResponseDto, saved, { excludeExtraneousValues: true }),
    };
  }

  async findUserById(id: number): Promise<User | null> {
    if (!id) {
      throw new NotFoundException('User ID required');
    }
    this.logger.log(`Finding user with id ${id}`);
    return this.usersRepository.findOne({ where: { id } });
  }

  async findUserByEmail(email: string): Promise<User | null> {
    if (!email) {
      throw new NotFoundException('Email required');
    }
    this.logger.log(`Finding user with email ${email}`);
    return this.usersRepository.findOne({ where: { email } });
  }

  async validatePassword(password: string, userId: number): Promise<boolean> {
    const user = await this.usersRepository.findOne({
      where: { id: userId },
      select: ['password'],
    });
    if (!user) {
      throw new NotFoundException(`User with ID ${userId} not found`);
    }
    return bcrypt.compare(password, user.password);
  }

  async findOne(id: number) {
    return this.usersRepository.findOne({ where: { id }, select: ['password'] });
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

  /**
   * Returns the artisan profile for a given user, including linked services and
   * the user's base data with addresses.
   *
   * @param userId - The user ID whose artisan profile to retrieve.
   * @returns `{ message, data: ArtisanProfileResponseDto }`.
   * @throws {NotFoundException} When no artisan profile exists for the user.
   */
  async findArtisanProfileByUserId(userId: number): Promise<{ message: string; data: ArtisanProfileResponseDto }> {
    const profile = await this.artisanProfilesRepository.findOne({
      where: { user: { id: userId } },
      relations: ['user', 'user.addresses', 'services'],
    });

    if (!profile) {
      throw new NotFoundException(`Artisan profile for user id ${userId} not found`);
    }

    return {
      message: SUCCESS_MESSAGES.ARTISAN_PROFILE.RETRIEVED,
      data: this.toArtisanProfileResponse(profile),
    };
  }

  /**
   * Applies a partial update to an artisan's profile, optionally replacing the
   * linked services list. Pass `serviceIds: []` to unlink all services.
   *
   * @param userId - The user ID whose artisan profile to update.
   * @param updateArtisanProfileDto - Fields to update.
   * @returns `{ message, data: ArtisanProfileResponseDto }` reflecting the saved state.
   * @throws {NotFoundException} When the artisan profile or any requested service is not found.
   */
  async updateArtisanProfile(
    userId: number,
    updateArtisanProfileDto: UpdateArtisanProfileDto,
  ): Promise<{ message: string; data: ArtisanProfileResponseDto }> {
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
        const services = await this.servicesRepository.findBy({ id: In(serviceIds) });
        if (services.length !== serviceIds.length) {
          throw new NotFoundException('One or more services were not found.');
        }
        profile.services = services;
      }
    }

    Object.assign(profile, profileUpdates);
    const saved = await this.artisanProfilesRepository.save(profile);

    const updated = await this.artisanProfilesRepository.findOne({
      where: { id: saved.id },
      relations: ['user', 'user.addresses', 'services'],
    });

    return {
      message: SUCCESS_MESSAGES.ARTISAN_PROFILE.UPDATED,
      data: this.toArtisanProfileResponse(updated!),
    };
  }

  /**
   * Returns the customer profile for a given user, including preferred services
   * and the user's base data with addresses.
   *
   * @param userId - The user ID whose customer profile to retrieve.
   * @returns `{ message, data: CustomerProfileResponseDto }`.
   * @throws {NotFoundException} When no customer profile exists for the user.
   */
  async findCustomerProfileByUserId(userId: number): Promise<{ message: string; data: CustomerProfileResponseDto }> {
    const profile = await this.customerProfilesRepository.findOne({
      where: { user: { id: userId } },
      relations: ['user', 'user.addresses', 'preferredServices'],
    });

    if (!profile) {
      throw new NotFoundException(`Customer profile for user id ${userId} not found`);
    }

    return {
      message: SUCCESS_MESSAGES.CUSTOMER_PROFILE.RETRIEVED,
      data: this.toCustomerProfileResponse(profile),
    };
  }

  /**
   * Applies a partial update to a customer's profile, optionally replacing the
   * preferred services list. Pass `preferredServiceIds: []` to clear all.
   * Budget validation (`max >= min`) is enforced before saving.
   *
   * @param userId - The user ID whose customer profile to update.
   * @param updateCustomerProfileDto - Fields to update.
   * @returns `{ message, data: CustomerProfileResponseDto }` reflecting the saved state.
   * @throws {NotFoundException} When the customer profile or any requested service is not found.
   * @throws {BadRequestException} When `budgetMax` is less than `budgetMin`.
   */
  async updateCustomerProfile(
    userId: number,
    updateCustomerProfileDto: UpdateCustomerProfileDto,
  ): Promise<{ message: string; data: CustomerProfileResponseDto }> {
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
        const preferredServices = await this.servicesRepository.findBy({ id: In(preferredServiceIds) });
        if (preferredServices.length !== preferredServiceIds.length) {
          throw new NotFoundException('One or more preferred services were not found.');
        }
        profile.preferredServices = preferredServices;
      }
    }

    Object.assign(profile, profileUpdates);
    const saved = await this.customerProfilesRepository.save(profile);

    const updated = await this.customerProfilesRepository.findOne({
      where: { id: saved.id },
      relations: ['user', 'user.addresses', 'preferredServices'],
    });

    return {
      message: SUCCESS_MESSAGES.CUSTOMER_PROFILE.UPDATED,
      data: this.toCustomerProfileResponse(updated!),
    };
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
