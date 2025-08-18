import { Test, TestingModule } from '@nestjs/testing';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

describe('UsersService', () => {
  let service: UsersService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [UsersService],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should create a user', () => {
    const dto: CreateUserDto = { /* mock properties if any */ } as CreateUserDto;
    const result = service.create(dto);
    expect(result).toBe('This action adds a new user');
  });

  it('should return all users', () => {
    expect(service.findAll()).toBe('This action returns all users');
  });

  it('should return a single user by id', () => {
    const id = 1;
    expect(service.findOne(id)).toBe(`This action returns a #${id} user`);
  });

  it('should update a user by id', () => {
    const id = 1;
    const dto: UpdateUserDto = { /* mock properties if any */ } as UpdateUserDto;
    expect(service.update(id, dto)).toBe(`This action updates a #${id} user`);
  });

  it('should remove a user by id', () => {
    const id = 1;
    expect(service.remove(id)).toBe(`This action removes a #${id} user`);
  });
});
