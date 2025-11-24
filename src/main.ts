import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { setupSwagger } from './config/swagger.config';
import { ValidationPipe } from '@nestjs/common';
import * as cors from 'cors';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const logger = app.get(WINSTON_MODULE_NEST_PROVIDER);

  app.useLogger(logger);
  app.useGlobalFilters( new AllExceptionsFilter(logger));
  app.enableCors({
    origin: process.env.ALLOWED_ORIGINS?.split(','),
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    preflightContinue: false,
    optionsSuccessStatus: 204,
  });

  app.useGlobalInterceptors(new ResponseInterceptor());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,  
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  

  app.setGlobalPrefix('api/v1');
  setupSwagger(app);
  await app.listen(process.env.PORT ?? 8000);
}
bootstrap();
