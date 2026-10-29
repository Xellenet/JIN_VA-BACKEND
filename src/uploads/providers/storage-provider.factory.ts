import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { LocalStorageProvider } from './local-storage.provider';
import { S3StorageProvider } from './s3-storage.provider';
import type { IStorageProvider } from './storage-provider.interface';

@Injectable()
export class StorageProviderFactory implements OnModuleInit {
  private readonly logger = new Logger(StorageProviderFactory.name);

  constructor(
    private readonly localProvider: LocalStorageProvider,
    private readonly s3Provider: S3StorageProvider,
  ) {}

  /**
   * PF2a: returns the active storage provider based on `STORAGE_PROVIDER`.
   * Local disk remains the default; flipping the variable to `'s3'` is the
   * operator's action and nothing in this codebase does it.
   */
  getProvider(): IStorageProvider {
    const providerName = process.env.STORAGE_PROVIDER ?? 'local';
    switch (providerName) {
      case 's3':
        return this.s3Provider;
      case 'local':
      default:
        return this.localProvider;
    }
  }

  /**
   * BI1: fail loudly, at boot, on a misconfigured cutover. The app still
   * starts — every non-upload route is unaffected, and BI1's acceptance
   * criterion requires the misconfiguration to surface as a clean 5xx *at the
   * point of upload* — but an operator who sets `STORAGE_PROVIDER=s3` without
   * the rest of the configuration sees it in the logs immediately instead of
   * discovering it via a user's failed avatar upload.
   *
   * Only variable **names** are logged, never values.
   */
  onModuleInit(): void {
    const provider = this.getProvider();
    const missing = provider.missingConfiguration();

    if (missing.length > 0) {
      this.logger.error(
        `Storage provider "${provider.providerName}" is selected but misconfigured — ` +
          `missing environment variables: ${missing.join(', ')}. ` +
          `Every upload will fail with a 500 until these are set.`,
      );
      return;
    }

    this.logger.log(`Storage provider "${provider.providerName}" is active.`);
  }
}
