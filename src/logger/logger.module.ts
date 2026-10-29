import { Module } from '@nestjs/common';
import { WinstonModule } from 'nest-winston';
import * as winston from 'winston';

@Module({
  imports: [
    WinstonModule.forRoot({
      transports: [
        /** Transport for console logs */
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.colorize(),
            winston.format.printf((info) => {
              const { level, message, context, timestamp } = info as {
                level: string;
                message: unknown;
                timestamp: unknown;
                context?: string;
              };
              return `[${String(timestamp)}] ${level} ${
                context ? '[' + context + ']' : ''
              }: ${String(message)}`;
            }),
          ),
        }),

        /** Transport for files errors */
        new winston.transports.File({
          filename: 'logs/error.log',
          level: 'error',
          format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.json(),
          ),
        }),

        /** Transport for all logs */
        new winston.transports.File({
          filename: 'logs/combined.log',
          format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.json(),
          ),
        }),
      ],
    }),
  ],
})
export class LoggerModule {}
