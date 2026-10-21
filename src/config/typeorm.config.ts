import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModuleAsyncOptions } from '@nestjs/typeorm';
import { ParameterlessQueryLogger } from './typeorm-logger';

export const typeOrmConfigAsync: TypeOrmModuleAsyncOptions = {
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    type: 'postgres',
    host: config.get<string>('DB_HOST'),
    port: config.get<number>('DB_PORT'),
    username: config.get<string>('DB_USER'),
    password: config.get<string>('DB_PASS'),
    database: config.get<string>('DB_NAME'),
    autoLoadEntities: true,
    synchronize: false,
    migrations: [__dirname + '/../migrations/*{.ts,.js}'],
    migrationsRun: true,
    // Same levels as before; failed queries are logged without their
    // parameter values (PR5/PR6).
    logger: new ParameterlessQueryLogger(
      config.get('NODE_ENV') !== 'production'
        ? ['error', 'warn', 'schema']
        : false,
    ),
  }),
};
