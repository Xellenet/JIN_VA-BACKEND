import type { ArgumentsHost } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Logger } from 'winston';
import { AllExceptionsFilter } from '@common/filters/all-exceptions.filter';
import { SocialOnlyAccountException } from '@common/exceptions/social-only-account.exception';
import { ERROR_MESSAGES } from '@common/constants/error-messages.constants';
import { ErrorResponse } from '@common/types/api-response.type';

describe('G10 end-to-end error shape via AllExceptionsFilter', () => {
  it('produces the exact contract shape for a social-only-account login attempt', () => {
    const winstonLoggerStub = { error: jest.fn() } as unknown as Logger;

    const jsonSpy = jest.fn<void, [ErrorResponse]>();
    const statusSpy = jest.fn().mockReturnValue({ json: jsonSpy });
    const mockResponse = { status: statusSpy } as unknown as Response;
    const mockRequest = {
      method: 'POST',
      url: '/api/v1/auth/login',
    } as unknown as Request;
    const mockHost = {
      switchToHttp: () => ({
        getResponse: () => mockResponse,
        getRequest: () => mockRequest,
      }),
    } as unknown as ArgumentsHost;

    const filter = new AllExceptionsFilter(winstonLoggerStub);
    const exception = new SocialOnlyAccountException(
      ERROR_MESSAGES.AUTH.SOCIAL_ONLY_ACCOUNT,
    );

    filter.catch(exception, mockHost);

    expect(statusSpy).toHaveBeenCalledWith(401);
    const body = jsonSpy.mock.calls[0][0];
    expect(body.status).toBe('error');
    expect(body.message).toBe(
      'This account signs in with Google. Continue with Google, or use "Forgot password" to set a password for this account.',
    );
    expect(body.meta.statusCode).toBe(401);
    expect(body.meta.error).toBe('SocialOnlyAccountException');
    expect(body.meta.error).not.toBe('InvalidCredentialsException');
  });
});
