import { UploadsService } from './uploads.service';
import type { StorageProviderFactory } from './providers/storage-provider.factory';
import type { LocalStorageProvider } from './providers/local-storage.provider';

function setup(activeName = 'local') {
  const local = { providerName: 'local', delete: jest.fn() };
  const s3 = { providerName: 's3', delete: jest.fn() };
  const factory = {
    getProvider: jest.fn(() => (activeName === 's3' ? s3 : local)),
  };
  const service = new UploadsService(
    factory as unknown as StorageProviderFactory,
    local as unknown as LocalStorageProvider,
  );
  const warn = jest
    .spyOn(
      (service as unknown as { logger: { warn: (m: string) => void } }).logger,
      'warn',
    )
    .mockImplementation(() => undefined);
  return { service, local, s3, warn };
}

describe('UploadsService.deleteOwnAvatar (B1)', () => {
  it('BU-3.1: deletes our own avatar file from local disk', async () => {
    const { service, local, s3 } = setup('local');
    await expect(
      service.deleteOwnAvatar('/uploads/avatars/3f2a.webp'),
    ).resolves.toBe(true);
    expect(local.delete).toHaveBeenCalledWith('3f2a.webp', 'avatars');
    expect(s3.delete).not.toHaveBeenCalled();
  });

  it('tries both stores when S3 is active (pre-cutover files live on disk)', async () => {
    const { service, local, s3 } = setup('s3');
    await service.deleteOwnAvatar('/uploads/avatars/3f2a.webp');
    expect(local.delete).toHaveBeenCalledWith('3f2a.webp', 'avatars');
    expect(s3.delete).toHaveBeenCalledWith('3f2a.webp', 'avatars');
  });

  it('never deletes a Google photo, and logs no path', async () => {
    const { service, local, warn } = setup('local');
    const google = 'https://lh3.googleusercontent.com/a/photo-id=s96-c';
    await expect(service.deleteOwnAvatar(google)).resolves.toBe(false);
    expect(local.delete).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).not.toContain('googleusercontent');
  });

  it('BU-3.2: a storage error is logged without the path and never thrown', async () => {
    const { service, local, warn } = setup('local');
    local.delete.mockRejectedValueOnce(new Error('EACCES /srv/uploads/x'));
    await expect(
      service.deleteOwnAvatar('/uploads/avatars/3f2a.webp'),
    ).resolves.toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).not.toContain('3f2a');
    expect(warn.mock.calls[0][0]).not.toContain('/srv');
  });
});
