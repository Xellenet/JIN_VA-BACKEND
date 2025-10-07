// src/users/user-token.service.ts
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { UserToken } from './entities/user-token.entity';
import { User } from './entities/user.entity';
import * as crypto from 'crypto';
import { Token } from '@common/types/enums';
import { isAfter, subMinutes } from 'date-fns';
import { VARIABLES } from '@common/constants/variables.constants';

@Injectable()
export class UserTokenService {
    private readonly logger = new Logger(UserTokenService.name);
  constructor(
    @InjectRepository(UserToken)
    private readonly tokenRepo: Repository<UserToken>,
  ) {}

  async createToken(
    user: User,
    type: Token,
    expiresInMinutes: number,
  ): Promise<UserToken> {

    await this.tokenRepo.delete({ user: { id: user.id }, type });

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + expiresInMinutes * 60 * 1000);
    this.logger.log(`Creating ${type} token for user with id: ${user.id}`);

    const userToken = this.tokenRepo.create({
      user,
      type,
      token,
      expiresAt,
    });

    this.logger.log(`Token created for user with id: ${user.id}`);
    return this.tokenRepo.save(userToken);
  }

  async validateToken(token: string, type: Token): Promise<User | null> {
    const userToken = await this.tokenRepo.findOne({
      where: { token, type },
      relations: ['user'],
    });
    this.logger.log(`Validating ${type} token for user with id: ${userToken?.user.id}`);


    if (!userToken || userToken.expiresAt < new Date()) {
        throw new BadRequestException("Invalid or expired token");
    }

    this.logger.log(`Token validated for user with id: ${userToken.user.id}`);


    return userToken.user;
  }

  async revokeToken(token: string): Promise<void> {

    this.logger.log(`Revoking token`);
    await this.tokenRepo.delete({ token });
  }

  async cleanupExpiredTokens(): Promise<void> {
    await this.tokenRepo.delete({ expiresAt: LessThan(new Date()) });
  }

  async getValidPasswordResetToken(userId: number): Promise<UserToken | null> {
    const token = await this.tokenRepo.findOne({
      where: {
        user: { id: userId },
        type: Token.PASSWORD_RESET,
      },
      order: { createdAt: 'DESC' },
    });

    if (!token) return null;

    const now = new Date();
    const expiryDate = token.expiresAt;
    if (isAfter(now, expiryDate)) {
      return null;
    }

    return token;
  }

  async createOrReusePasswordResetToken(userId: number): Promise<UserToken> {
    let token = await this.getValidPasswordResetToken(userId);
    if (token) {
      return token;
    }

    const newToken = this.tokenRepo.create({
      user: { id: userId },
      type: Token.PASSWORD_RESET,
      token: crypto.randomBytes(32).toString('hex'),
      expiresAt: subMinutes(new Date(), -VARIABLES.PASSWORD_RESET_TOKEN_EXPIRES_IN_MINUTES), // valid for `ttlMinutes`
    });

    return this.tokenRepo.save(newToken);
  }
}