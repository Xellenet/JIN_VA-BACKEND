import { Injectable } from '@nestjs/common';
import { ManualVerificationProvider } from './manual-verification.provider';
import type { IVerificationProvider } from './verification-provider.interface';

@Injectable()
export class VerificationProviderFactory {
  constructor(private readonly manualProvider: ManualVerificationProvider) {}

  getProvider(): IVerificationProvider {
    const providerName = process.env.KYC_PROVIDER ?? 'manual';
    switch (providerName) {
      case 'manual':
      default:
        return this.manualProvider;
    }
  }
}
