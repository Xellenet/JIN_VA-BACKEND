import * as winston from 'winston';
import { redactLogInfo } from '@common/utils/redact.util';

/**
 * SEC-31: replaces the values of sensitive keys (passwords, codes, emails,
 * phone numbers, card and payout details, authorization data) with
 * `"[redacted]"` at any depth of a log line's metadata, before any transport
 * formats it.
 */
export const redactFormat = winston.format(
  (info) =>
    redactLogInfo(info as unknown as Record<string, unknown>) as typeof info,
);

export const winstonConfig = {
  format: redactFormat(),
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
