import { Injectable } from '@nestjs/common';
import { LocalStorageProvider } from './local-storage.provider';
import type { IStorageProvider } from './storage-provider.interface';

@Injectable()
export class StorageProviderFactory {
  constructor(private readonly localProvider: LocalStorageProvider) {}

  getProvider(): IStorageProvider {
    const providerName = process.env.STORAGE_PROVIDER ?? 'local';
    switch (providerName) {
      case 'local':
      default:
        return this.localProvider;
    }
  }
}
