import { BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import { Readable } from 'node:stream';
import { KycMediaService } from './kyc-media.service';
import type { LocalStorageProvider } from './providers/local-storage.provider';
import type { StorageProviderFactory } from './providers/storage-provider.factory';
import type {
  IStorageProvider,
  PrivateMediaObject,
} from './providers/storage-provider.interface';

/**
 * The single reader for KYC media. What matters here:
 *   - only `documents`/`selfies` are addressable, and only with a filename
 *     that cannot be a path,
 *   - a pre-cutover document on local disk is still found while the active
 *     provider is S3 (otherwise flipping STORAGE_PROVIDER 404s the whole
 *     existing verification backlog), and
 *   - a miss is a 404 that reveals nothing about which store was consulted.
 */

const OBJECT: PrivateMediaObject = {
  stream: Readable.from(['bytes']),
  contentType: 'image/jpeg',
  contentLength: 5,
};

const ADMIN_ID = 42;
const FILENAME = '11fc2f6a-517a-4354-bb3e-1a023cdd2940.jpg';

describe('KycMediaService', () => {
  let localRead: jest.Mock;
  let activeRead: jest.Mock;
  let activeProviderName: string;
  let service: KycMediaService;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    localRead = jest.fn().mockResolvedValue(null);
    activeRead = jest.fn().mockResolvedValue(null);
    activeProviderName = 'local';

    const local = {
      providerName: 'local',
      readPrivate: localRead,
    } as unknown as LocalStorageProvider;
    const factory = {
      getProvider: (): IStorageProvider =>
        ({
          providerName: activeProviderName,
          readPrivate: activeRead,
        }) as unknown as IStorageProvider,
    } as unknown as StorageProviderFactory;

    service = new KycMediaService(factory, local);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('folder and filename validation', () => {
    it('serves the two KYC folders', async () => {
      localRead.mockResolvedValue(OBJECT);

      await expect(service.open('documents', FILENAME, ADMIN_ID)).resolves.toBe(
        OBJECT,
      );
      await expect(service.open('selfies', FILENAME, ADMIN_ID)).resolves.toBe(
        OBJECT,
      );
    });

    it('refuses a public folder, so this endpoint cannot become a general file proxy', async () => {
      for (const folder of ['avatars', 'portfolio', 'reviews', 'messages']) {
        await expect(
          service.open(folder, FILENAME, ADMIN_ID),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
      expect(localRead).not.toHaveBeenCalled();
    });

    it('refuses a filename that could be a path, before touching any store', async () => {
      for (const filename of [
        '../../package.json',
        'a/b.jpg',
        'a\\b.jpg',
        '.env',
        '',
      ]) {
        await expect(
          service.open('documents', filename, ADMIN_ID),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
      expect(localRead).not.toHaveBeenCalled();
    });
  });

  describe('store selection', () => {
    it('reads local disk first, and does not consult the active provider when it hits', async () => {
      activeProviderName = 's3';
      localRead.mockResolvedValue(OBJECT);

      await expect(service.open('documents', FILENAME, ADMIN_ID)).resolves.toBe(
        OBJECT,
      );
      expect(localRead).toHaveBeenCalledWith('documents', FILENAME);
      expect(activeRead).not.toHaveBeenCalled();
    });

    it('falls back to S3 when the object is not on disk (a post-cutover upload)', async () => {
      activeProviderName = 's3';
      activeRead.mockResolvedValue(OBJECT);

      await expect(service.open('selfies', FILENAME, ADMIN_ID)).resolves.toBe(
        OBJECT,
      );
      expect(activeRead).toHaveBeenCalledWith('selfies', FILENAME);
    });

    it('does not ask twice when local disk IS the active provider', async () => {
      activeProviderName = 'local';

      await expect(
        service.open('documents', FILENAME, ADMIN_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(localRead).toHaveBeenCalledTimes(1);
      expect(activeRead).not.toHaveBeenCalled();
    });

    it('404s without naming a store, a path or a bucket when nothing holds the object', async () => {
      activeProviderName = 's3';

      const thrown = await service.open('documents', FILENAME, ADMIN_ID).then(
        () => null,
        (err: unknown) => err,
      );

      expect(thrown).toBeInstanceOf(NotFoundException);
      const message = (thrown as NotFoundException).message;
      expect(message).toBe('That verification file is no longer available.');
      expect(message).not.toContain('documents');
      expect(message).not.toContain(FILENAME);
      expect(message).not.toContain('s3');
    });
  });

  it('attributes every successful read to the acting admin', async () => {
    const logSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    localRead.mockResolvedValue(OBJECT);

    await service.open('documents', FILENAME, ADMIN_ID);

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(String(logSpy.mock.calls[0][0])).toContain(`Admin #${ADMIN_ID}`);
    expect(String(logSpy.mock.calls[0][0])).toContain(`documents/${FILENAME}`);
  });
});
