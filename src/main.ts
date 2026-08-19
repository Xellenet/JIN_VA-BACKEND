import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { TypeOrmFilter } from './common/filters/typeorm-exception.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { setupSwagger } from './config/swagger.config';
import { ValidationPipe } from '@nestjs/common';
import { join } from 'path';
import cookieParser from 'cookie-parser';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    rawBody: true, // exposes req.rawBody — required for Paystack webhook signature verification
  });
  const logger = app.get(WINSTON_MODULE_NEST_PROVIDER);

  app.useLogger(logger);
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

  // Serve uploaded files (e.g. avatars) at /uploads/*
  app.useStaticAssets(join(process.cwd(), 'uploads'), { prefix: '/uploads' });

  app.setGlobalPrefix('api/v1', { exclude: ['/'] });
  setupSwagger(app);
  await app.listen(process.env.PORT ?? 8000);
}
bootstrap();
