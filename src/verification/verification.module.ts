import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { VerificationController } from './verification.controller';
import { VerificationService } from './verification.service';
import { ArtisanVerification } from './entities/artisan-verification.entity';
import { ManualVerificationProvider } from './providers/manual-verification.provider';
import { VerificationProviderFactory } from './providers/verification-provider.factory';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';

@Module({
  imports: [TypeOrmModule.forFeature([ArtisanVerification, ArtisanProfile])],
  controllers: [VerificationController],
  providers: [VerificationService, ManualVerificationProvider, VerificationProviderFactory],
  exports: [VerificationService],
})
export class VerificationModule {}
