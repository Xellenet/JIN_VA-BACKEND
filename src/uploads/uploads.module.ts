import { Module } from '@nestjs/common';
import { UploadsController } from './uploads.controller';
import { UploadsService } from './uploads.service';
import { LocalStorageProvider } from './providers/local-storage.provider';
import { StorageProviderFactory } from './providers/storage-provider.factory';

@Module({
  controllers: [UploadsController],
  providers: [UploadsService, LocalStorageProvider, StorageProviderFactory],
  exports: [UploadsService, StorageProviderFactory],
})
export class UploadsModule {}
