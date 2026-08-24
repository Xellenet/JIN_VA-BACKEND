import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('/ (GET) returns the uptime health-check payload', () => {
    // Pre-existing stale assertion: this was still the Nest scaffold's
    // `'Hello World!'` long after `AppController.healthCheck()` was changed to
    // return `{ status: 'ok' }` (commit "fix: uptime health check"), so the
    // e2e suite had a permanently red test unrelated to any feature. Aligned
    // with the real contract — `/` is excluded from the `api/v1` global prefix
    // and is what uptime monitoring polls.
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect({ status: 'ok' });
  });
});
