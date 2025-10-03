import { applyDecorators, Type } from '@nestjs/common';
import { ApiOkResponse, ApiCreatedResponse, ApiBadRequestResponse, ApiNotFoundResponse, ApiInternalServerErrorResponse, getSchemaPath } from '@nestjs/swagger';

interface ApiResponseOptions {
  message?: string;
  model?: Type<any>;   // DTO class
  isArray?: boolean;
  paginated?: boolean;
}

/**
 * Standardized Swagger response decorator
 */
export function ApiResponseSuccess(options: ApiResponseOptions) {
  const { message = 'Request successful', model, isArray = false, paginated = false } = options;

  const dataSchema = model
    ? {
        type: isArray ? 'array' : 'object',
        items: isArray ? { $ref: getSchemaPath(model) } : undefined,
        $ref: !isArray ? getSchemaPath(model) : undefined,
      }
    : { type: 'object' };

  const baseResponse = {
    status: 'success',
    message,
    data: dataSchema,
    meta: {
      timestamp: '2025-09-10T14:00:00.000Z',
      path: '/api/v1/example',
      statusCode: 200,
      ...(paginated
        ? {
            pagination: {
              page: 1,
              limit: 10,
              totalItems: 100,
              totalPages: 10,
            },
          }
        : {}),
    },
  };

  return applyDecorators(
    ApiOkResponse({
      description: message,
      schema: { example: baseResponse },
    }),
  );
}

/**
 * Standardized Swagger error decorators
 */
export function ApiResponseErrors() {
  return applyDecorators(
    ApiBadRequestResponse({
      description: 'Bad Request',
      schema: {
        example: {
          status: 'error',
          message: ['Invalid input data'],
          meta: {
            timestamp: '2025-09-10T14:00:00.000Z',
            path: '/api/v1/example',
            statusCode: 400,
            error: 'BadRequestException',
          },
        },
      },
    }),
    ApiNotFoundResponse({
      description: 'Resource not found',
      schema: {
        example: {
          status: 'error',
          message: 'User not found',
          meta: {
            timestamp: '2025-09-10T14:00:00.000Z',
            path: '/api/v1/users/123',
            statusCode: 404,
            error: 'NotFoundException',
          },
        },
      },
    }),
    ApiInternalServerErrorResponse({
      description: 'Internal server error',
      schema: {
        example: {
          status: 'error',
          message: 'Internal server error',
          meta: {
            timestamp: '2025-09-10T14:00:00.000Z',
            path: '/api/v1/example',
            statusCode: 500,
            error: 'InternalServerError',
          },
        },
      },
    }),
  );
}
