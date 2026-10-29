import { In } from 'typeorm';
import { DevicePlatform } from '@common/types/enums';
import { PushNotificationsService } from './push-notifications.service';
import type { PushProviderFactory } from './providers/push-provider.factory';

describe('PushNotificationsService', () => {
  let service: PushNotificationsService;

  const tokensRepo = {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn((v: object) => ({ ...v })),
    save: jest.fn((v: object) => Promise.resolve(v)),
    delete: jest.fn(),
  };
  const prefsRepo = { findOne: jest.fn() };
  const provider = { providerName: 'fake', send: jest.fn() };
  const factory = { get: () => provider };
  const payload = { title: 'New message', body: 'Hello' };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new PushNotificationsService(
      tokensRepo as never,
      prefsRepo as never,
      factory as unknown as PushProviderFactory,
    );
    jest.spyOn(service['logger'], 'log').mockImplementation();
    jest.spyOn(service['logger'], 'warn').mockImplementation();
  });

  describe('registerDevice', () => {
    it('creates a new token record for the user', async () => {
      tokensRepo.findOne.mockResolvedValueOnce(null);
      const dto = { token: 'tok-new', platform: DevicePlatform.ANDROID };

      const res = await service.registerDevice(3, dto);

      expect(tokensRepo.create).toHaveBeenCalledWith({ ...dto, userId: 3 });
      expect(tokensRepo.save).toHaveBeenCalledWith({ ...dto, userId: 3 });
      expect(res.message).toBe('Device registered for push notifications.');
    });

    // A device handed to another account must stop receiving the previous
    // owner's notifications.
    it('re-associates an existing token with the current user and platform', async () => {
      const existing = {
        id: 1,
        token: 'tok-1',
        userId: 99,
        platform: DevicePlatform.ANDROID,
      };
      tokensRepo.findOne.mockResolvedValueOnce(existing);

      await service.registerDevice(3, {
        token: 'tok-1',
        platform: DevicePlatform.IOS,
      });

      expect(tokensRepo.create).not.toHaveBeenCalled();
      expect(tokensRepo.save).toHaveBeenCalledWith({
        id: 1,
        token: 'tok-1',
        userId: 3,
        platform: DevicePlatform.IOS,
      });
    });
  });

  it('unregisterDevice deletes only the token owned by that user', async () => {
    const res = await service.unregisterDevice(3, 'tok-1');

    expect(tokensRepo.delete).toHaveBeenCalledWith({
      userId: 3,
      token: 'tok-1',
    });
    expect(res.message).toBe('Device unregistered.');
  });

  describe('sendToUser', () => {
    it('sends nothing when the user turned push off', async () => {
      prefsRepo.findOne.mockResolvedValueOnce({ pushEnabled: false });

      await service.sendToUser(3, payload);

      expect(tokensRepo.find).not.toHaveBeenCalled();
      expect(provider.send).not.toHaveBeenCalled();
    });

    it('sends nothing when the user has no registered devices', async () => {
      prefsRepo.findOne.mockResolvedValueOnce({ pushEnabled: true });
      tokensRepo.find.mockResolvedValueOnce([]);

      await service.sendToUser(3, payload);

      expect(provider.send).not.toHaveBeenCalled();
    });

    it('defaults to sending when no preferences row exists', async () => {
      prefsRepo.findOne.mockResolvedValueOnce(null);
      tokensRepo.find.mockResolvedValueOnce([{ token: 'a' }, { token: 'b' }]);
      provider.send.mockResolvedValueOnce({
        successCount: 2,
        failedTokens: [],
      });

      await service.sendToUser(3, payload);

      expect(tokensRepo.find).toHaveBeenCalledWith({
        where: { userId: 3 },
        select: ['token'],
      });
      expect(provider.send).toHaveBeenCalledWith(['a', 'b'], payload);
      expect(tokensRepo.delete).not.toHaveBeenCalled();
    });

    it('prunes the tokens the provider reports as failed', async () => {
      prefsRepo.findOne.mockResolvedValueOnce({ pushEnabled: true });
      tokensRepo.find.mockResolvedValueOnce([{ token: 'a' }, { token: 'b' }]);
      provider.send.mockResolvedValueOnce({
        successCount: 1,
        failedTokens: ['b'],
      });

      await service.sendToUser(3, payload);

      expect(tokensRepo.delete).toHaveBeenCalledWith({ token: In(['b']) });
    });
  });
});
