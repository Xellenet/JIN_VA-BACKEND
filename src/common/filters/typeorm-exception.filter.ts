import { ArgumentsHost, Catch, ExceptionFilter } from "@nestjs/common";
import { QueryFailedError } from "typeorm";


@Catch(QueryFailedError)
export class TypeOrmFilter implements ExceptionFilter {
  catch(exception: QueryFailedError, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const request = ctx.getRequest();

    let message = 'Database operation failed';
    let status = 500;

    if (exception.cause === '23505') {
      if (exception.name?.includes('email')) {
        message = 'Email already exists';
      } else if (exception.name?.includes('username')) {
        message = 'Username already exists';
      } else {
        message = 'Duplicate entry detected';
      }
      status = 409; 
    }

    response.status(status).json({
      status: 'error',
      message,
      meta: {
        timestamp: new Date().toISOString(),
        path: request.url,
        statusCode: status,
      },
    });
  }
}