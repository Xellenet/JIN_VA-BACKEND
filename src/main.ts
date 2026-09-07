import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { TypeOrmFilter } from './common/filters/typeorm-exception.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { setupSwagger } from './config/swagger.config';
import { Logger, ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { applyLegacyMediaServing } from './uploads/legacy-media.config';
import type { Logger as WinstonLogger } from 'winston';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    rawBody: true, // exposes req.rawBody — required for Paystack webhook signature verification
  });
  const logger = app.get<WinstonLogger>(WINSTON_MODULE_NEST_PROVIDER);

  app.useLogger(logger);

  /**
   * The auth rate limits key on the client IP, so `req.ip` has to actually *be*
   * the client. Behind a proxy or load balancer (Render, nginx, Cloudflare) it
   * isn't: Express reports the nearest hop unless it is told how many hops to
   * trust — which would put every user of the platform into a single
   * rate-limit bucket and start rejecting logins globally after ten attempts.
   *
   * `TRUST_PROXY_HOPS` is the number of proxies in front of this process (1 for
   * a typical single PaaS/reverse proxy). Express then resolves the client
   * address from `X-Forwarded-For`, skipping exactly that many trusted hops
   * counted from the connection inwards. It is deliberately a hop *count*
   * rather than `trust proxy: true`: `true` takes the left-most `X-Forwarded-For`
   * entry, which is whatever the caller chose to put there, making an IP-keyed
   * limit trivially bypassable.
   *
   * Unset (or 0) means "not behind a proxy" — `req.ip` stays the socket
   * address, which is correct for local development and for a directly-exposed
   * process. **Any hosted environment must set this**, or per-IP limits are
   * per-deployment limits.
   */
  const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS ?? 0);
  if (Number.isInteger(trustProxyHops) && trustProxyHops > 0) {
    app.set('trust proxy', trustProxyHops);
    new Logger('Bootstrap').log(
      `Trusting ${trustProxyHops} proxy hop(s) for client IP resolution`,
    );
  }

  app.useGlobalFilters(new AllExceptionsFilter(logger), new TypeOrmFilter());
  app.enableCors({
    origin: process.env.ALLOWED_ORIGINS?.split(','),
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    preflightContinue: false,
    optionsSuccessStatus: 204,
    // Required for the browser to send/receive the HttpOnly refresh + session
    // cookies (S1/S2) cross-origin between the frontend and API domains.
    credentials: true,
  });

  // Required for reading the HttpOnly refresh-token / session cookies (S1/S2).
  app.use(cookieParser());

  app.useGlobalInterceptors(new ResponseInterceptor());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // BI2: media delivery. This used to be an unconditional
  // `useStaticAssets(join(process.cwd(), 'uploads'), { prefix: '/uploads' })`,
  // which made the NestJS process the media CDN in every environment. It is
  // now driven by `applyLegacyMediaServing()` — read the header comment in
  // `src/uploads/legacy-media.config.ts` for why we kept a legacy-scoped
  // static handler instead of migrating the stored URLs.
  //
  // Logged with Nest's own Logger (already routed into winston by `useLogger`
  // above) because the injected nest-winston LoggerService exposes `log`, not
  // `info`.
  new Logger('MediaServing').log(applyLegacyMediaServing(app).description);

  app.setGlobalPrefix('api/v1', { exclude: ['/'] });
  setupSwagger(app);
  await app.listen(process.env.PORT ?? 8000);
}
void bootstrap();
