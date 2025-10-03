import { Test, TestingModule } from '@nestjs/testing';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { CreateUserDto } from '@users/dto/create-user.dto';

describe('AuthController', () => {
  let controller: AuthController;
  let authService: AuthService;

  const mockAuthService = {
    registerUser: jest.fn(),
    loginUser: jest.fn(),
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

  describe('registerUser', () => {
    it('should call authService.registerUser and return result', async () => {
      const dto: CreateUserDto = { email: 'test@example.com', password: 'pass' } as CreateUserDto;
      const expected = { id: 1, email: dto.email };
      mockAuthService.registerUser.mockResolvedValueOnce(expected);

      const result = await controller.registerUser(dto);

      expect(authService.registerUser).toHaveBeenCalledWith(dto);
      expect(result).toEqual(expected);
    });
  });

  describe('loginUser', () => {
    it('should call authService.loginUser and return result', async () => {
      const loginDto = { email: 'test@example.com', password: 'pass' };
      const expected = { access_token: 'token' };
      mockAuthService.loginUser.mockResolvedValueOnce(expected);

      const result = await controller.loginUser(loginDto);

      expect(authService.loginUser).toHaveBeenCalledWith(loginDto);
      expect(result).toEqual(expected);
    });
  });
});
