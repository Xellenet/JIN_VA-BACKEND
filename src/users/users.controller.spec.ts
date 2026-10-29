import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import type { Response } from 'express';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { UploadsService } from '../uploads/uploads.service';
import { CreateUserDto } from './dto/create-user.dto';
import type { AuthenticatedRequest } from '@common/types/authenticated-request.type';
import { VARIABLES } from '@common/constants/variables.constants';

describe('UsersController', () => {
  let controller: UsersController;

  const mockUsersService = {
    createUser: jest.fn(),
    deleteMe: jest.fn(),
  };
  const mockUploadsService = {
    uploadAvatar: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        { provide: UsersService, useValue: mockUsersService },
        { provide: UploadsService, useValue: mockUploadsService },
      ],
    }).compile();

    controller = module.get<UsersController>(UsersController);

    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('createUser', () => {
    it('should call usersService.createUser with dto and return result', async () => {
      const dto: CreateUserDto = {
        email: 'test@example.com',
        password: 'pass',
      } as CreateUserDto;
      const expected = { id: 1, email: dto.email };
      mockUsersService.createUser.mockResolvedValueOnce(expected);

      const result = await controller.createUser(dto);

      expect(mockUsersService.createUser).toHaveBeenCalledWith(dto);
      expect(result).toEqual(expected);
    });
  });

  /**
   * Item 2 (security `L2` / qa `B4`, which also closes qa `FE-6`): deleting an
   * account has to end the session on *this* device, and must not touch it
   * when the deletion is refused.
   */
  describe('DELETE /users/me — session cookies', () => {
    const req = { user: { id: 7 } } as AuthenticatedRequest;

    const makeRes = () => {
      const cookie = jest.fn();
      return { res: { cookie } as unknown as Response, cookie };
    };

    /** Name → the options the handler passed, for every `res.cookie` call. */
    const clearedCookies = (cookie: jest.Mock) =>
      Object.fromEntries(
        (cookie.mock.calls as unknown[][]).map((call) => [
          call[0] as string,
          call[2] as { maxAge?: number; expires?: Date },
        ]),
      );

    it('clears both auth cookies on a successful deletion', async () => {
      const deletion = {
        message: 'Account deleted successfully.',
        data: { deletedAt: new Date(), purgeAt: new Date(), retentionDays: 30 },
      };
      mockUsersService.deleteMe.mockResolvedValueOnce(deletion);
      const { res, cookie } = makeRes();

      const result = await controller.deleteMe(req, res);

      // The success body is unchanged — this fix adds headers, nothing else.
      expect(result).toBe(deletion);
      const cleared = clearedCookies(cookie);
      for (const name of [
        VARIABLES.REFRESH_TOKEN_COOKIE_NAME,
        VARIABLES.AUTH_SESSION_COOKIE_NAME,
      ]) {
        expect(cleared[name]).toBeDefined();
        expect(cleared[name].maxAge).toBe(0);
        expect(cleared[name].expires).toEqual(new Date(0));
      }
    });

    it('clears nothing when the deletion is refused, so the caller stays authenticated', async () => {
      mockUsersService.deleteMe.mockRejectedValueOnce(
        new ConflictException({
          message: "Your account can't be deleted yet — …",
          errorCode: 'ACCOUNT_HAS_LIVE_COMMITMENTS',
        }),
      );
      const { res, cookie } = makeRes();

      await expect(controller.deleteMe(req, res)).rejects.toThrow(
        ConflictException,
      );
      expect(cookie).not.toHaveBeenCalled();
    });

    it('still reports success if writing the clearing headers fails', async () => {
      const deletion = { message: 'ok', data: {} };
      mockUsersService.deleteMe.mockResolvedValueOnce(deletion);
      const res = {
        cookie: jest.fn(() => {
          throw new Error('headers already sent');
        }),
      } as unknown as Response;

      // The deletion has already committed; a cookie-header failure must not
      // surface as an error the user would retry.
      await expect(controller.deleteMe(req, res)).resolves.toBe(deletion);
    });
  });
});
