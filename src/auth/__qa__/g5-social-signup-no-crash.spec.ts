import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { UsersService } from '@users/users.service';
import { User } from '@users/entities/user.entity';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { CustomerProfile } from '@users/entities/customer-profile.entity';
import { Address } from '@users/entities/address.entity';
import { ServiceEntity } from '@services/entities/service.entity';
import { UserTokenService } from '@users/token.service';
import { CreateUserDto } from '@users/dto/create-user.dto';
import { Role } from '@common/types/enums';

/**
 * QA verification (google-oauth-fix, G5): a brand-new Google signup calls
 * `UsersService.createUser()` with no `password` and no `gender` (see
 * `AuthService.registerSocialUser`). This must succeed and persist
 * `password: null` rather than crashing on a NOT NULL constraint or a
 * `bcrypt.hash(undefined, ...)` call — exercised here against the real
 * `UsersService.createUser` body (only the TypeORM repositories are mocked,
 * never a live DB), for both CUSTOMER and ARTISAN signup roles.
 */
describe('UsersService.createUser — brand-new Google/social signup (G5)', () => {
  let service: UsersService;
  let usersRepo: { findOne: jest.Mock; create: jest.Mock; save: jest.Mock };
  let artisanProfilesRepo: { create: jest.Mock; save: jest.Mock };
  let customerProfilesRepo: { create: jest.Mock; save: jest.Mock };

  beforeEach(async () => {
    usersRepo = {
      findOne: jest.fn().mockResolvedValue(null), // no existing account by email
      create: jest.fn((data: Record<string, unknown>) => data),
      save: jest.fn((data: Record<string, unknown>) =>
        Promise.resolve({ id: 42, ...data }),
      ),
    };
    artisanProfilesRepo = {
      create: jest.fn((data: Record<string, unknown>) => data),
      save: jest.fn().mockResolvedValue({}),
    };
    customerProfilesRepo = {
      create: jest.fn((data: Record<string, unknown>) => data),
      save: jest.fn().mockResolvedValue({}),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: getRepositoryToken(User), useValue: usersRepo },
        {
          provide: getRepositoryToken(ArtisanProfile),
          useValue: artisanProfilesRepo,
        },
        {
          provide: getRepositoryToken(CustomerProfile),
          useValue: customerProfilesRepo,
        },
        { provide: getRepositoryToken(Address), useValue: {} },
        { provide: getRepositoryToken(ServiceEntity), useValue: {} },
        { provide: UserTokenService, useValue: {} },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  it('does not crash and stores password: null for a brand-new CUSTOMER social signup with no password/gender', async () => {
    const dto = {
      email: 'new-google-customer@example.com',
      firstname: 'New',
      lastname: 'Signup',
      socialProvider: 'google',
      socialProviderId: 'google-id-1',
      isSocialLogin: true,
      role: Role.CUSTOMER,
      // deliberately no `password`, no `gender` — matches
      // AuthService.registerSocialUser's payload shape.
    } as unknown as CreateUserDto;

    const { data: user } = await service.createUser(dto);

    expect(user).toBeDefined();
    expect(usersRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ password: null }),
    );
    expect(customerProfilesRepo.save).toHaveBeenCalled();
    expect(artisanProfilesRepo.save).not.toHaveBeenCalled();
  });

  it('does not crash for a brand-new ARTISAN social signup with no password/gender', async () => {
    const dto = {
      email: 'new-google-artisan@example.com',
      firstname: 'New',
      lastname: 'Artisan',
      socialProvider: 'google',
      socialProviderId: 'google-id-2',
      isSocialLogin: true,
      role: Role.ARTISAN,
    } as unknown as CreateUserDto;

    const { data: user } = await service.createUser(dto);

    expect(user).toBeDefined();
    expect(usersRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ password: null }),
    );
    expect(artisanProfilesRepo.save).toHaveBeenCalled();
  });
});
