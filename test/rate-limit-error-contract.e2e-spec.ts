import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { In, Repository } from 'typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import type { Logger as WinstonLogger } from 'winston';
import { AppModule } from '../src/app.module';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { TypeOrmFilter } from '../src/common/filters/typeorm-exception.filter';
import { User } from '@users/entities/user.entity';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { Message } from '@messages/entities/message.entity';
import { Conversation } from '@messages/entities/conversation.entity';
import { Notification } from '../src/notifications/entities/notification.entity';
import { UserTokenService } from '@users/token.service';
import { Role } from '@common/types/enums';

/**
 * QA verification (messaging-notifications RL1 — error-body contract).
 *
 * The other messaging e2e spec boots the app the way the Nest testing docs
 * show (ValidationPipe + ResponseInterceptor only). Production does NOT: it
 * also registers `AllExceptionsFilter` + `TypeOrmFilter` globally
 * (`src/main.ts`). That filter rewrites every error body into the app's own
 * `{ status, message, meta }` envelope.
 *
 * This spec reproduces the real production wiring exactly, so the 429 body a
 * browser actually receives can be compared against the contract the frontend
 * was told to code against (api-contract.md section 3.1, which says: "Match on
 * `error === "MESSAGE_RATE_LIMIT_EXCEEDED"` rather than on the status code
 * alone" and documents a top-level `retryAfterSeconds`).
 *
 * Run: npm run test:e2e -- rate-limit-error-contract
 *
 * QA test code only. Fixtures removed in `afterAll`.
 */
jest.setTimeout(120000);

describe('RL1 429 error-body contract, with production global filters (e2e)', () => {
  let app: INestApplication<App>;
  let userRepo: Repository<User>;
  let profileRepo: Repository<ArtisanProfile>;
  let messageRepo: Repository<Message>;
  let conversationRepo: Repository<Conversation>;
  let notificationRepo: Repository<Notification>;
  let tokenService: UserTokenService;

  let customer: User;
  let customerToken: string;
  let artisanUser: User;
  let artisanProfile: ArtisanProfile;

  const uniq = Date.now();
  const server = () => app.getHttpServer();

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    const logger = app.get<WinstonLogger>(WINSTON_MODULE_NEST_PROVIDER);

    // Mirror src/main.ts exactly.
    app.useGlobalFilters(new AllExceptionsFilter(logger), new TypeOrmFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.setGlobalPrefix('api/v1', { exclude: ['/'] });
    await app.init();

    userRepo = moduleFixture.get(getRepositoryToken(User));
    profileRepo = moduleFixture.get(getRepositoryToken(ArtisanProfile));
    messageRepo = moduleFixture.get(getRepositoryToken(Message));
    conversationRepo = moduleFixture.get(getRepositoryToken(Conversation));
    notificationRepo = moduleFixture.get(getRepositoryToken(Notification));
    tokenService = moduleFixture.get(UserTokenService);

    customer = await userRepo.save(
      userRepo.create({
        email: `qa-rl-customer-${uniq}@test.jinva.local`,
        password: null,
        firstname: 'QaRl',
        lastname: 'Customer',
        role: Role.CUSTOMER,
        accountVerified: true,
        isBanned: false,
      }),
    );
    customerToken = (await tokenService.createJWTTokens(customer)).access_token;

    artisanUser = await userRepo.save(
      userRepo.create({
        email: `qa-rl-artisan-${uniq}@test.jinva.local`,
        password: null,
        firstname: 'QaRl',
        lastname: 'Artisan',
        role: Role.ARTISAN,
        accountVerified: true,
        isBanned: false,
      }),
    );
    artisanProfile = await profileRepo.save(
      profileRepo.create({
        user: artisanUser,
        currency: 'GHS',
        isVerified: true,
        isProfileComplete: true,
      }),
    );
  });

  afterAll(async () => {
    const ignore = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch {
        /* ignore */
      }
    };
    const ids = [customer.id, artisanUser.id];
    await ignore(() =>
      notificationRepo
        .createQueryBuilder()
        .delete()
        .where('user_id IN (:...ids)', { ids })
        .execute(),
    );
    const convs = await conversationRepo
      .createQueryBuilder('c')
      .where(
        'c.participant_a_id IN (:...ids) OR c.participant_b_id IN (:...ids)',
        {
          ids,
        },
      )
      .getMany();
    if (convs.length) {
      const convIds = convs.map((c) => c.id);
      await ignore(() =>
        messageRepo
          .createQueryBuilder()
          .delete()
          .where('conversation_id IN (:...convIds)', { convIds })
          .execute(),
      );
      await ignore(() => conversationRepo.delete({ id: In(convIds) }));
    }
    await ignore(() => profileRepo.delete({ id: artisanProfile.id }));
    await ignore(() => userRepo.delete({ id: In(ids) }));
    await app.close();
  });

  it('the 429 body a browser really receives, vs api-contract.md section 3.1', async () => {
    let limited: request.Response | null = null;
    for (let i = 0; i < 60; i++) {
      const res = await request(server())
        .post('/api/v1/messages')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ recipientId: artisanUser.id, content: `rl probe ${i}` });
      if (res.status === 429) {
        limited = res;
        break;
      }
      expect(res.status).toBe(201);
    }
    expect(limited).not.toBeNull();

    const body = limited!.body as Record<string, unknown> & {
      meta?: Record<string, unknown>;
    };

    // Evidence for the report: dump the real shape.
    console.log('REAL 429 BODY =', JSON.stringify(body));

    // What DOES survive: the user-facing copy. RL1's "clear error, never a raw
    // 429" is satisfied in substance — apiFetch throws Error(body.message).
    expect(typeof body.message).toBe('string');
    expect(String(body.message)).toMatch(/sending messages too fast/i);

    // The app-wide envelope means these are NOT at the top level — they live
    // under `meta`. api-contract.md section 3.1 documents this explicitly.
    expect(body.error).toBeUndefined();
    expect(body.retryAfterSeconds).toBeUndefined();
    expect(body.statusCode).toBeUndefined();

    // QA B1 (re-verified 2026-08-21 after commit 4085fbe): the filter now
    // promotes the guard's opt-in errorCode/retryAfterSeconds into meta, so a
    // client can detect a rate limit without string-matching user-facing copy.
    // Before the fix meta.error carried the exception CLASS NAME
    // ("HttpException") and retryAfterSeconds was dropped entirely.
    expect(body.meta?.error).toBe('MESSAGE_RATE_LIMIT_EXCEEDED');
    expect(typeof body.meta?.retryAfterSeconds).toBe('number');
    expect(body.meta?.retryAfterSeconds as number).toBeGreaterThan(0);
    expect(body.meta?.statusCode).toBe(429);
  });
});
