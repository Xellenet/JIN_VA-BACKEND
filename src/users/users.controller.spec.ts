import { Test, TestingModule } from '@nestjs/testing';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

describe('UsersController', () => {
  let controller: UsersController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [UsersService],
    }).compile();

    controller = module.get<UsersController>(UsersController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
let usersService: UsersService;

beforeEach(async () => {
  usersService = {
    create: jest.fn().mockReturnValue('created'),
    findAll: jest.fn().mockReturnValue('all users'),
    findOne: jest.fn().mockReturnValue('one user'),
    update: jest.fn().mockReturnValue('updated'),
    remove: jest.fn().mockReturnValue('removed'),
  } as any;

  const module: TestingModule = await Test.createTestingModule({
    controllers: [UsersController],
    providers: [{ provide: UsersService, useValue: usersService }],
  }).compile();

  controller = module.get<UsersController>(UsersController);
});

describe('create', () => {
  it('should call usersService.create with dto and return result', () => {
    const dto = { name: 'test' } as any;
    expect(controller.create(dto)).toBe('created');
    expect(usersService.create).toHaveBeenCalledWith(dto);
  });
});

describe('findAll', () => {
  it('should call usersService.findAll and return result', () => {
    expect(controller.findAll()).toBe('all users');
    expect(usersService.findAll).toHaveBeenCalled();
  });
});

describe('findOne', () => {
  it('should call usersService.findOne with id as number and return result', () => {
    expect(controller.findOne('7')).toBe('one user');
    expect(usersService.findOne).toHaveBeenCalledWith(7);
  });
});

describe('update', () => {
  it('should call usersService.update with id as number and dto and return result', () => {
    const dto = { name: 'updated' } as any;
    expect(controller.update('3', dto)).toBe('updated');
    expect(usersService.update).toHaveBeenCalledWith(3, dto);
  });
});

describe('remove', () => {
  it('should call usersService.remove with id as number and return result', () => {
    expect(controller.remove('2')).toBe('removed');
    expect(usersService.remove).toHaveBeenCalledWith(2);
  });
});
