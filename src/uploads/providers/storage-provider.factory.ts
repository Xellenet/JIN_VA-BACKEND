import { Injectable } from '@nestjs/common';
import { LocalStorageProvider } from './local-storage.provider';
import { S3StorageProvider } from './s3-storage.provider';
import type { IStorageProvider } from './storage-provider.interface';

@Injectable()
export class StorageProviderFactory {
  constructor(
    private readonly localProvider: LocalStorageProvider,
    private readonly s3Provider: S3StorageProvider,
  ) {}

  /**
   * PF2a: returns the active storage provider based on `STORAGE_PROVIDER`.
   * No live environment sets this to `'s3'` yet — local-disk remains the
   * default until the user performs that cutover themselves.
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
}
