import { Test, TestingModule } from '@nestjs/testing';
import { UsersService } from './users.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { User } from './entities/user.entity';
import { ArtisanProfile } from './entities/artisan-profile.entity';
import { CustomerProfile } from './entities/customer-profile.entity';
import { Address } from './entities/address.entity';
import { ServiceEntity } from '@services/entities/service.entity';
import { UserTokenService } from './token.service';
import { CreateUserDto } from './dto/create-user.dto';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { UserAlreadyExists } from '@common/exceptions/user-already-exists.exception';
import { Role } from '@common/types/enums';
import { SUCCESS_MESSAGES } from '@common/constants/success-messages.constants';

describe('UsersService', () => {
  let service: UsersService;

  const mockUser = {
    id: 1,
    email: 'test@example.com',
    password: 'hashed',
    role: Role.CUSTOMER,
  } as User;

  const mockUsersRepository = {
    create: jest.fn(),
    save: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    softDelete: jest.fn(),
  };
  const mockArtisanProfilesRepository = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
  };
  const mockCustomerProfilesRepository = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
  };
  const mockAddressesRepository = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    remove: jest.fn(),
  };
  const mockServicesRepository = {
    findBy: jest.fn(),
  };
  const mockUserTokenService = {
    revokeRefreshTokenForUser: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: getRepositoryToken(User), useValue: mockUsersRepository },
        {
          provide: getRepositoryToken(ArtisanProfile),
          useValue: mockArtisanProfilesRepository,
        },
        {
          provide: getRepositoryToken(CustomerProfile),
          useValue: mockCustomerProfilesRepository,
        },
        {
          provide: getRepositoryToken(Address),
          useValue: mockAddressesRepository,
        },
        {
          provide: getRepositoryToken(ServiceEntity),
          useValue: mockServicesRepository,
        },
        { provide: UserTokenService, useValue: mockUserTokenService },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
    jest.clearAllMocks();
  });

  describe('createUser', () => {
    it('should throw BadRequestException if email is missing', async () => {
      await expect(
        service.createUser({ password: 'pass' } as CreateUserDto),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw UserAlreadyExists if user already exists', async () => {
      mockUsersRepository.findOne.mockResolvedValueOnce(mockUser);
      const dto: CreateUserDto = {
        email: mockUser.email,
        password: 'pass',
      } as CreateUserDto;
      await expect(service.createUser(dto)).rejects.toThrow(UserAlreadyExists);
    });

    it('should create and save a CUSTOMER user with an auto-provisioned customer profile', async () => {
      const dto: CreateUserDto = {
        email: 'new@example.com',
        password: 'pass',
        role: Role.CUSTOMER,
      } as CreateUserDto;
      const created = { ...dto, id: 2, password: 'hashed' };
      mockUsersRepository.findOne.mockResolvedValueOnce(null); // no existing user
      mockUsersRepository.create.mockReturnValueOnce(created);
      mockUsersRepository.save.mockResolvedValueOnce(created);
      mockCustomerProfilesRepository.create.mockReturnValueOnce({
        user: created,
      });
      mockCustomerProfilesRepository.save.mockResolvedValueOnce({});

      const result = await service.createUser(dto);

      expect(mockUsersRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ email: dto.email }),
      );
      expect(mockUsersRepository.save).toHaveBeenCalledWith(created);
      expect(mockCustomerProfilesRepository.save).toHaveBeenCalled();
      expect(result).toEqual({
        message: SUCCESS_MESSAGES.USER.CREATED,
        data: created,
      });
    });
  });

  describe('findUserByEmail', () => {
    it('should throw NotFoundException if email is missing', async () => {
      await expect(
        service.findUserByEmail(undefined as unknown as string),
      ).rejects.toThrow(NotFoundException);
    });

    it('should return the user if found', async () => {
      mockUsersRepository.findOne.mockResolvedValueOnce(mockUser);
      const result = await service.findUserByEmail(mockUser.email);

      expect(mockUsersRepository.findOne).toHaveBeenCalledWith({
        where: { email: mockUser.email },
      });
      expect(result).toEqual(mockUser);
    });

    it('should return null if user not found', async () => {
      mockUsersRepository.findOne.mockResolvedValueOnce(null);
      const result = await service.findUserByEmail('notfound@example.com');
      expect(result).toBeNull();
    });
  });

  describe('findMe', () => {
    it('should throw NotFoundException when the user does not exist', async () => {
      mockUsersRepository.findOne.mockResolvedValueOnce(null);
      await expect(service.findMe(999)).rejects.toThrow(NotFoundException);
    });

    it('should return the wrapped user profile when found', async () => {
      mockUsersRepository.findOne.mockResolvedValueOnce(mockUser);
      const result = await service.findMe(mockUser.id);
      expect(result.message).toBe(SUCCESS_MESSAGES.USER.RETRIEVED);
      expect(result.data.id).toBe(mockUser.id);
    });
  });

  describe('deleteMe', () => {
    it('should throw NotFoundException when the user does not exist', async () => {
      mockUsersRepository.findOne.mockResolvedValueOnce(null);
      await expect(service.deleteMe(999)).rejects.toThrow(NotFoundException);
    });

    it('should revoke refresh tokens and soft-delete the user', async () => {
      mockUsersRepository.findOne.mockResolvedValueOnce(mockUser);
      const result = await service.deleteMe(mockUser.id);

      expect(
        mockUserTokenService.revokeRefreshTokenForUser,
      ).toHaveBeenCalledWith(mockUser.id);
      expect(mockUsersRepository.softDelete).toHaveBeenCalledWith({
        id: mockUser.id,
      });
      expect(result).toEqual({ message: SUCCESS_MESSAGES.USER.DELETED });
    });
  });

  describe('findOne', () => {
    it('should query by id, selecting only the password column', async () => {
      mockUsersRepository.findOne.mockResolvedValueOnce(mockUser);
      const result = await service.findOne(mockUser.id);

      expect(mockUsersRepository.findOne).toHaveBeenCalledWith({
        where: { id: mockUser.id },
        select: ['password'],
      });
      expect(result).toEqual(mockUser);
    });
  });

  describe('remove', () => {
    it('should delete the user by id', async () => {
      await service.remove(mockUser.id);
      expect(mockUsersRepository.delete).toHaveBeenCalledWith(mockUser.id);
    });
  });
});
