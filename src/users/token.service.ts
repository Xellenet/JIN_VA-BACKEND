// src/users/user-token.service.ts
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { UserToken } from './entities/user-token.entity';
import { User } from './entities/user.entity';
import * as crypto from 'node:crypto';
import { Token } from '@common/types/enums';
import { isAfter, subMinutes } from 'date-fns';
import { VARIABLES } from '@common/constants/variables.constants';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class UserTokenService {
    private readonly logger = new Logger(UserTokenService.name);
  constructor(
    @InjectRepository(UserToken)
    private readonly tokenRepo: Repository<UserToken>,
    private readonly jwtService: JwtService,
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

  /**
   * Validate a user token
   * @param token - The token to validate
   * @param type - The type of token
   * @returns The user associated with the token or null if invalid
   */
  async validateToken(token: string, type: Token): Promise<User | null> {
    const userToken = await this.tokenRepo.findOne({
      where: { token, type },
      relations: ['user'],
    });
    this.logger.log(`Validating ${type} token for user with id: ${userToken?.user.id}`);

    if(userToken && userToken.type === Token.REFRESH) {
      try {
        this.jwtService.verify(token, { ignoreExpiration: true }); 
        this.logger.log(`JWT token verified for user with id: ${userToken.user.id}`);
      } catch (error) {
        this.logger.warn(`JWT token verification failed: ${error.message}`);
        throw new BadRequestException("Invalid or expired token");
      }
      return userToken.user;
    }
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

async createJWTTokens(user: User): Promise<{ access_token: string, refresh_token: string }> {
    const payload = { sub: user.id, email: user.email, role: user.role };
    
    // Debug: Log env vars
    const accessExpiresIn = process.env.JWT_ACCESS_EXPIRES_IN || '15m';
    const refreshExpiresIn = process.env.JWT_REFRESH_EXPIRES_IN || '7d';
    this.logger.log(`Access expiresIn: ${accessExpiresIn}, Refresh expiresIn: ${refreshExpiresIn}`);
    
    // Use the JwtService configuration provided by AuthModule and only set expiresIn here.
    // Accessing internal module internals can be undefined and cause runtime errors.
    const accessOptions = { expiresIn: accessExpiresIn };
    this.logger.log(`Final access options: expiresIn=${accessOptions.expiresIn}`);

    let access_token: string;
    try {
      access_token = this.jwtService.sign(payload, accessOptions);
      this.logger.log('Access token signed successfully');
    } catch (signError) {
      this.logger.error(`Access sign error: ${signError.message}`, signError.stack);
      throw signError;
    }

    const refreshOptions = { expiresIn: refreshExpiresIn };
    let refresh_token: string;
    try {
      refresh_token = this.jwtService.sign(payload, refreshOptions);
      this.logger.log('Refresh token signed successfully');
    } catch (signError) {
      this.logger.error(`Refresh sign error: ${signError.message}`, signError.stack);
      throw signError;
    }
    
    this.logger.log(`Created JWT tokens for user with id: ${user.id}`);

    // Persist the refresh token in DB
    const refreshEntity = this.tokenRepo.create({
      token: refresh_token,
      user: { id: user.id },
      type: Token.REFRESH,
      expiresAt: subMinutes(new Date(), -VARIABLES.REFRESH_TOKEN_EXPIRES_IN_DAYS * 24 * 60),
    });

    await this.tokenRepo.save(refreshEntity);

    return { access_token, refresh_token };
  }

  async revokeRefreshTokenForUser(userId: number): Promise<void> {
    this.logger.log(`Revoking refresh tokens for user with id: ${userId}`);
    await this.tokenRepo.delete({ user: { id: userId }, type: Token.REFRESH });
  }
    
}