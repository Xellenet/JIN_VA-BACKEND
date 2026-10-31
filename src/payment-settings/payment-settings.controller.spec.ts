import { Test } from '@nestjs/testing';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import type { AuthenticatedRequest } from '@common/types/authenticated-request.type';
import { ROLES_KEY } from '@common/decorators/roles.decorator';
import { Role } from '@common/types/enums';
import { NotSuspendedGuard } from '@common/guards/not-suspended.guard';
import { PaymentSettingsWriteThrottlerGuard } from '@common/throttling/customer-throttler.guards';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PaymentSettingsController } from './payment-settings.controller';
import { PaymentSettingsService } from './payment-settings.service';

describe('PaymentSettingsController', () => {
  const service = {
    getSettings: jest.fn(),
    updateSettings: jest.fn(),
  };
  let controller: PaymentSettingsController;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      controllers: [PaymentSettingsController],
      providers: [{ provide: PaymentSettingsService, useValue: service }],
    })
      .overrideGuard(PaymentSettingsWriteThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(PaymentSettingsController);
    jest.clearAllMocks();
  });

  const req = {
    user: { id: 11 },
    ip: '203.0.113.3',
    headers: { 'user-agent': 'jest' },
  } as unknown as AuthenticatedRequest;

  it('GET reads the caller from the JWT only', async () => {
    service.getSettings.mockResolvedValueOnce({ message: 'm', data: {} });
    await controller.getSettings(req);
    expect(service.getSettings).toHaveBeenCalledWith(11);
  });

  it('PATCH passes the caller, the body and the request context', async () => {
    service.updateSettings.mockResolvedValueOnce({ message: 'm', data: {} });
    await controller.updateSettings(req, { preferredChannel: 'card' });
    expect(service.updateSettings).toHaveBeenCalledWith(
      11,
      { preferredChannel: 'card' },
      { ip: '203.0.113.3', userAgent: 'jest' },
    );
  });

  it('T-6: GET is JWT + customer role; PATCH adds the suspension check and its throttle', () => {
    const proto = PaymentSettingsController.prototype;
    expect(Reflect.getMetadata(GUARDS_METADATA, proto.getSettings)).toEqual([
      JwtAuthGuard,
      RolesGuard,
    ]);
    expect(Reflect.getMetadata(GUARDS_METADATA, proto.updateSettings)).toEqual([
      JwtAuthGuard,
      RolesGuard,
      NotSuspendedGuard,
      PaymentSettingsWriteThrottlerGuard,
    ]);
    expect(Reflect.getMetadata(ROLES_KEY, proto.getSettings)).toEqual([
      Role.CUSTOMER,
    ]);
    expect(Reflect.getMetadata(ROLES_KEY, proto.updateSettings)).toEqual([
      Role.CUSTOMER,
    ]);
  });
});
