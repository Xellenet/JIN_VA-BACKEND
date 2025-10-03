// src/config/swagger.config.ts
import { DocumentBuilder, SwaggerModule,SwaggerDocumentOptions } from '@nestjs/swagger';
import { INestApplication } from '@nestjs/common';


export function setupSwagger(app: INestApplication) {
  const config = new DocumentBuilder()
    .setTitle('Jinva API')
    .setDescription('API documentation for the Jinva application')
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const documentOptions: SwaggerDocumentOptions = {
    deepScanRoutes: true,
    autoTagControllers: true,
  };

  const document = SwaggerModule.createDocument(app, config, documentOptions);
  SwaggerModule.setup('api/docs', app, document);
}
