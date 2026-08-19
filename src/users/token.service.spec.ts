import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import { UserTokenService } from './token.service';
import { UserToken } from './entities/user-token.entity';
import { Token } from '@common/types/enums';

describe('UserTokenService', () => {
  let service: UserTokenService;

  const mockUser = { id: 1, email: 'test@example.com' };

  const mockTokenRepo = {
    findOne: jest.fn(),
    delete: jest.fn(),
  };

  const mockJwtService = {
    verify: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserTokenService,
        { provide: getRepositoryToken(UserToken), useValue: mockTokenRepo },
        { provide: JwtService, useValue: mockJwtService },
      ],
    }).compile();

    service = module.get<UserTokenService>(UserTokenService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('consumeRefreshToken (S5)', () => {
    const futureExpiry = new Date(Date.now() + 60 * 60 * 1000);
    const pastExpiry = new Date(Date.now() - 60 * 60 * 1000);

    it('returns null when the token does not exist', async () => {
      mockTokenRepo.findOne.mockResolvedValueOnce(null);

      const result = await service.consumeRefreshToken('unknown-token');

      expect(result).toBeNull();
      expect(mockTokenRepo.delete).not.toHaveBeenCalled();
    });

    it('deletes the row and returns the user for a valid, unexpired, unconsumed token', async () => {
      mockTokenRepo.findOne.mockResolvedValueOnce({
        id: 'row-1',
        token: 'valid-token',
        type: Token.REFRESH,
        expiresAt: futureExpiry,
        user: mockUser,
      });
      mockTokenRepo.delete.mockResolvedValueOnce({ affected: 1 });
      mockJwtService.verify.mockReturnValueOnce({ sub: mockUser.id });

      const result = await service.consumeRefreshToken('valid-token');

      expect(mockTokenRepo.delete).toHaveBeenCalledWith({ id: 'row-1' });
      expect(result).toEqual(mockUser);
    });

    it('returns null when the delete affects zero rows (lost the race / already consumed — replay protection)', async () => {
      mockTokenRepo.findOne.mockResolvedValueOnce({
        id: 'row-1',
        token: 'replayed-token',
        type: Token.REFRESH,
        expiresAt: futureExpiry,
        user: mockUser,
      });
      mockTokenRepo.delete.mockResolvedValueOnce({ affected: 0 });

      const result = await service.consumeRefreshToken('replayed-token');

      expect(result).toBeNull();
      // Must not fall through to JWT verification once the race is lost.
      expect(mockJwtService.verify).not.toHaveBeenCalled();
    });

    it('returns null when the DB row is already past its expiry, even if the delete succeeded', async () => {
      mockTokenRepo.findOne.mockResolvedValueOnce({
        id: 'row-1',
        token: 'expired-token',
        type: Token.REFRESH,
        expiresAt: pastExpiry,
        user: mockUser,
      });
      mockTokenRepo.delete.mockResolvedValueOnce({ affected: 1 });

      const result = await service.consumeRefreshToken('expired-token');

      expect(result).toBeNull();
    });

    it('returns null when JWT verification fails (bad signature / tampered token)', async () => {
      mockTokenRepo.findOne.mockResolvedValueOnce({
        id: 'row-1',
        token: 'bad-signature-token',
        type: Token.REFRESH,
        expiresAt: futureExpiry,
        user: mockUser,
      });
      mockTokenRepo.delete.mockResolvedValueOnce({ affected: 1 });
      mockJwtService.verify.mockImplementationOnce(() => {
        throw new Error('invalid signature');
      });

      const result = await service.consumeRefreshToken('bad-signature-token');

      expect(result).toBeNull();
    });
  });
});
