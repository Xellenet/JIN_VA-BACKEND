import * as winston from 'winston';

export const winstonConfig = {
  transports: [
    process.env.NODE_ENV === 'production'
      ? new winston.transports.Console({
          format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.json(),
          ),
        })
      : new winston.transports.Console({
          format: winston.format.combine(
            winston.format.colorize({ all: true }),
            winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
            winston.format.printf((info) => {
              const { level, message, timestamp, context } = info as {
                level: string;
                message: unknown;
                timestamp: unknown;
                context?: string;
              };
              return `[${String(timestamp)}] ${level} ${
                context ? `[${context}]` : ''
              }: ${String(message)}`;
            }),
          ),
        }),
  ],
};
