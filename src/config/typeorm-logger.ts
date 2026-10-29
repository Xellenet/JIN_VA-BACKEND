import { AdvancedConsoleLogger, QueryRunner } from 'typeorm';

/**
 * PR5/PR6: TypeORM's console logger prints a failed (or slow) query together
 * with its bound PARAMETERS, so an ordinary duplicate-phone 409 on
 * /auth/register would write the email, phone number and password hash to the
 * dev console. This logger keeps the SQL text (which only has $1..$n
 * placeholders) and the error, and never logs the parameter values.
 */
export class ParameterlessQueryLogger extends AdvancedConsoleLogger {
  logQueryError(
    error: string,
    query: string,
    _parameters?: unknown[],
    queryRunner?: QueryRunner,
  ): void {
    super.logQueryError(error, query, undefined, queryRunner);
  }

  logQuerySlow(
    time: number,
    query: string,
    _parameters?: unknown[],
    queryRunner?: QueryRunner,
  ): void {
    super.logQuerySlow(time, query, undefined, queryRunner);
  }
}
