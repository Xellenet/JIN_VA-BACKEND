import { Module } from '@nestjs/common';
import { UploadsController } from './uploads.controller';
import { UploadsService } from './uploads.service';
import { KycMediaService } from './kyc-media.service';
import { LocalStorageProvider } from './providers/local-storage.provider';
import { S3StorageProvider } from './providers/s3-storage.provider';
import { StorageProviderFactory } from './providers/storage-provider.factory';

@Module({
  controllers: [UploadsController],
  providers: [
    UploadsService,
    KycMediaService,
    LocalStorageProvider,
    S3StorageProvider,
    StorageProviderFactory,
  ],
  // C1.7: `KycMediaService` is exported for the account purge, which has to
  // delete a purged artisan's identity documents and verification selfie from
  // storage. Deliberately the service and not the providers, so the
  // "which store holds it" rule stays in one place.
  exports: [UploadsService, StorageProviderFactory, KycMediaService],
})
export class UploadsModule {}
