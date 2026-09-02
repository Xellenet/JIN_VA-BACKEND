import { StorageProviderFactory } from './storage-provider.factory';
import type { IStorageProvider } from './storage-provider.interface';

/**
 * BI1: provider selection plus the boot-time "fail loudly" check.
 *
 * `STORAGE_PROVIDER` is set only on `process.env` inside this isolated jest
 * process and restored afterwards — no real environment is ever cut over here.
 */
describe('StorageProviderFactory', () => {
  const ORIGINAL_STORAGE_PROVIDER = process.env.STORAGE_PROVIDER;

  const stub = (
    providerName: string,
    missing: string[] = [],
  ): IStorageProvider => ({
    providerName,
    upload: jest.fn(),
    delete: jest.fn(),
    missingConfiguration: jest.fn(() => missing),
  });

  const build = (local: IStorageProvider, s3: IStorageProvider) =>
    new StorageProviderFactory(local as never, s3 as never);

  afterEach(() => {
    if (ORIGINAL_STORAGE_PROVIDER === undefined) {
      delete process.env.STORAGE_PROVIDER;
    } else {
      process.env.STORAGE_PROVIDER = ORIGINAL_STORAGE_PROVIDER;
    }
  });

  describe('getProvider()', () => {
    it('defaults to local when STORAGE_PROVIDER is unset', () => {
      delete process.env.STORAGE_PROVIDER;
      const factory = build(stub('local'), stub('s3'));
      expect(factory.getProvider().providerName).toBe('local');
    });

    it('returns the S3 provider when STORAGE_PROVIDER is "s3"', () => {
      process.env.STORAGE_PROVIDER = 's3';
      const factory = build(stub('local'), stub('s3'));
      expect(factory.getProvider().providerName).toBe('s3');
    });

    it('falls back to local for an unrecognised value rather than crashing', () => {
      process.env.STORAGE_PROVIDER = 'cloudinary';
      const factory = build(stub('local'), stub('s3'));
      expect(factory.getProvider().providerName).toBe('local');
    });
  });

  describe('onModuleInit() — BI1 loud misconfiguration', () => {
    it('logs an error naming every missing variable when the active provider is misconfigured', () => {
      process.env.STORAGE_PROVIDER = 's3';
      const factory = build(
        stub('local'),
        stub('s3', ['AWS_S3_BUCKET', 'AWS_S3_REGION']),
      );
      const errorSpy = jest
        .spyOn(factory['logger'], 'error')
        .mockImplementation(() => undefined);

      factory.onModuleInit();

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const message = String(errorSpy.mock.calls[0][0]);
      expect(message).toContain('AWS_S3_BUCKET');
      expect(message).toContain('AWS_S3_REGION');
      expect(message).toContain('500');
      errorSpy.mockRestore();
    });

    it('does not warn about the inactive provider when local is selected', () => {
      delete process.env.STORAGE_PROVIDER;
      const factory = build(stub('local'), stub('s3', ['AWS_S3_BUCKET']));
      const errorSpy = jest
        .spyOn(factory['logger'], 'error')
        .mockImplementation(() => undefined);
      const logSpy = jest
        .spyOn(factory['logger'], 'log')
        .mockImplementation(() => undefined);

      factory.onModuleInit();

      expect(errorSpy).not.toHaveBeenCalled();
      expect(String(logSpy.mock.calls[0][0])).toContain('local');
      errorSpy.mockRestore();
      logSpy.mockRestore();
    });
  });
});
