import { Test, TestingModule } from '@nestjs/testing';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { CreateUserDto } from '@users/dto/create-user.dto';

describe('AuthController', () => {
  let controller: AuthController;
  let authService: AuthService;

  const mockAuthService = {
    registerUser: jest.fn(),
    login: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: mockAuthService },
      ],
    }).compile();

    controller = module.get<AuthController>(AuthController);
    authService = module.get<AuthService>(AuthService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('register', () => {
    it('should call authService.registerUser and return result', async () => {
      const dto: CreateUserDto = { email: 'test@example.com', password: 'pass' } as CreateUserDto;
      const expected = { id: 1, email: dto.email };
      mockAuthService.registerUser.mockResolvedValueOnce(expected);

      const result = await controller.register(dto);

      expect(authService.registerUser).toHaveBeenCalledWith(dto);
      expect(result).toEqual(expected);
    });
  });

  // describe('login', () => {
  //   it('should call authService.login and return result', async () => {
  //     const req = { user: { id: 1, email: 'test@example.com' } };
  //     const expected = { access_token: 'token' };
  //     mockAuthService.login.mockResolvedValueOnce(expected);

  //     const result = await controller.login(req);

  //     expect(authService.login).toHaveBeenCalledWith(req.user);
  //     expect(result).toEqual(expected);
  //   });
  // });
});
