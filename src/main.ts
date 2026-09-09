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
import { resolveTrustProxyHops } from './config/trust-proxy.config';
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
   * the client. `resolveTrustProxyHops` owns that decision — including
   * refusing to boot a production deployment that never said whether it sits
   * behind a proxy, because "unset" used to mean "trust nothing" *and* be the
   * default, which is the one setting that silently collapses every per-IP
   * limit into a single platform-wide bucket. Read the header comment in
   * `src/config/trust-proxy.config.ts` for the full reasoning.
   *
   * The setting is always logged, in every configuration, so the effective
   * value is visible in the boot log rather than inferred from its absence.
   */
  const trustProxy = resolveTrustProxyHops();
  const bootLogger = new Logger('Bootstrap');
  if (trustProxy.hops > 0) {
    app.set('trust proxy', trustProxy.hops);
  }
  if (trustProxy.warn) {
    bootLogger.warn(trustProxy.description);
  } else {
    bootLogger.log(trustProxy.description);
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
