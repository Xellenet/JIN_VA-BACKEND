import { BadRequestException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import {
  PIN_NOT_ACCEPTED,
  RejectPinFieldsGuard,
} from './reject-pin-fields.guard';

const ctx = (body: unknown) =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ body }) }),
  }) as unknown as ExecutionContext;

describe('RejectPinFieldsGuard', () => {
  const guard = new RejectPinFieldsGuard();

  it('lets a body without PIN-like keys through', () => {
    expect(guard.canActivate(ctx({ network: 'MTN', otp: '123456' }))).toBe(
      true,
    );
    expect(guard.canActivate(ctx(undefined))).toBe(true);
  });

  it.each([{ pin: '1234' }, { momoPin: '1' }, { nested: { PIN_CODE: '1' } }])(
    'refuses %p with 400 PIN_NOT_ACCEPTED and never echoes the value',
    (body) => {
      try {
        guard.canActivate(ctx(body));
        throw new Error('expected a 400');
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
        const res = (err as BadRequestException).getResponse();
        expect(res).toMatchObject({ errorCode: PIN_NOT_ACCEPTED });
        expect(JSON.stringify(res)).not.toContain('1234');
      }
    },
  );
});
