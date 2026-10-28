import { DevicePlatform } from '@common/types/enums';
import type { AuthenticatedRequest } from '@common/types/authenticated-request.type';
import { PushNotificationsController } from './push-notifications.controller';
import type { PushNotificationsService } from './push-notifications.service';

describe('PushNotificationsController', () => {
  const service = {
    registerDevice: jest.fn(),
    unregisterDevice: jest.fn(),
  };
  const controller = new PushNotificationsController(
    service as unknown as PushNotificationsService,
  );
  const req = { user: { id: 7 } } as unknown as AuthenticatedRequest;

  beforeEach(() => jest.clearAllMocks());

  it('registers the device for the authenticated user', async () => {
    const dto = { token: 'tok-1', platform: DevicePlatform.IOS };
    const result = { message: 'Device registered for push notifications.' };
    service.registerDevice.mockResolvedValueOnce(result);

    await expect(controller.register(req, dto)).resolves.toBe(result);
    expect(service.registerDevice).toHaveBeenCalledWith(7, dto);
  });

  it('unregisters only the given token for the authenticated user', async () => {
    const result = { message: 'Device unregistered.' };
    service.unregisterDevice.mockResolvedValueOnce(result);

    await expect(controller.unregister(req, { token: 'tok-1' })).resolves.toBe(
      result,
    );
    expect(service.unregisterDevice).toHaveBeenCalledWith(7, 'tok-1');
  });
});
