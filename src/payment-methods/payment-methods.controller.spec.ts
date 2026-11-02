import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ROLES_KEY } from '@common/decorators/roles.decorator';
import { Role } from '@common/types/enums';
import { RejectPinFieldsGuard } from '@common/guards/reject-pin-fields.guard';
import { NotSuspendedGuard } from '@common/guards/not-suspended.guard';
import type { AuthenticatedRequest } from '@common/types/authenticated-request.type';
import { PaymentMethodsController } from './payment-methods.controller';
import type { PaymentMethodsService } from './payment-methods.service';
import { MobileMoneyMethodDto } from './dto/mobile-money-method.dto';

describe('PaymentMethodsController', () => {
  const methods = {
    list: jest.fn(),
    resolve: jest.fn(),
    addMobileMoney: jest.fn(),
    setDefault: jest.fn(),
    remove: jest.fn(),
  };
  const controller = new PaymentMethodsController(
    methods as unknown as PaymentMethodsService,
  );
  const req = {
    user: { id: 22 },
    ip: '127.0.0.1',
    headers: { 'user-agent': 'jest' },
  } as unknown as AuthenticatedRequest;
  const ctx = { ip: '127.0.0.1', userAgent: 'jest' };
  const dto = { network: 'MTN', accountNumber: '0240000000' } as const;

  beforeEach(() => {
    jest.clearAllMocks();
    Object.values(methods).forEach((fn) => fn.mockResolvedValue({ ok: true }));
  });

  it('passes the JWT subject (never a body id) to every call', async () => {
    await expect(controller.list(req)).resolves.toEqual({
      message: 'Payment methods retrieved',
      data: { ok: true },
    });
    expect(methods.list).toHaveBeenCalledWith(22);
    await controller.resolve(dto);
    expect(methods.resolve).toHaveBeenCalledWith(dto);
    await controller.addMobileMoney(req, dto);
    expect(methods.addMobileMoney).toHaveBeenCalledWith(22, dto, ctx);
    await controller.setDefault(req, 4);
    expect(methods.setDefault).toHaveBeenCalledWith(22, 4);
    await controller.remove(req, 4);
    expect(methods.remove).toHaveBeenCalledWith(22, 4, ctx);
  });

  const handlers = [
    'list',
    'resolve',
    'addMobileMoney',
    'setDefault',
    'remove',
  ] as const;

  it.each(handlers)('%s is customer-only and never cached', (name) => {
    const handler = PaymentMethodsController.prototype[name];
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([Role.CUSTOMER]);
    const headers = Reflect.getMetadata('__headers__', handler) as Array<{
      name: string;
      value: string;
    }>;
    expect(headers).toContainEqual({
      name: 'Cache-Control',
      value: 'private, no-store',
    });
    expect(
      (Reflect.getMetadata('__guards__', handler) as unknown[]).length,
    ).toBeGreaterThanOrEqual(3);
  });

  it('the number-carrying writes refuse PIN fields; saving needs an unsuspended account', () => {
    for (const name of ['resolve', 'addMobileMoney'] as const) {
      const guards = Reflect.getMetadata(
        '__guards__',
        PaymentMethodsController.prototype[name],
      ) as unknown[];
      expect(guards).toContain(RejectPinFieldsGuard);
    }
    expect(
      Reflect.getMetadata(
        '__guards__',
        PaymentMethodsController.prototype.addMobileMoney,
      ),
    ).toContain(NotSuspendedGuard);
  });

  describe('MobileMoneyMethodDto', () => {
    const check = async (body: Record<string, unknown>) => {
      const obj = plainToInstance(MobileMoneyMethodDto, body);
      return { obj, errors: await validate(obj) };
    };

    it('normalises +233 and the network case', async () => {
      const { obj, errors } = await check({
        network: 'vod',
        accountNumber: '+233 20 000 0000',
      });
      expect(errors).toHaveLength(0);
      expect(obj).toMatchObject({
        network: 'VOD',
        accountNumber: '0200000000',
      });
    });

    it.each([
      [{ network: 'MTN', accountNumber: '0300000000' }, 'accountNumber'],
      [{ network: 'MTN', accountNumber: '02400' }, 'accountNumber'],
      [{ network: 'TELECEL', accountNumber: '0240000000' }, 'network'],
      [{ network: 'MTN', accountNumber: 240000000 }, 'accountNumber'],
    ])('refuses %p on %s without echoing the value', async (body, field) => {
      const { errors } = await check(body);
      expect(errors.map((e) => e.property)).toContain(field);
      expect(JSON.stringify(errors.map((e) => e.constraints))).not.toContain(
        '0300000000',
      );
    });
  });
});
