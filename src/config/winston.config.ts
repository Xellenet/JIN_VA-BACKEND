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
            winston.format.printf(({ level, message, timestamp, context }) => {
              return `[${timestamp}] ${level} ${context ? `[${context}]` : ''}: ${message}`;
            }),
          ),
        }),
  ],
};
