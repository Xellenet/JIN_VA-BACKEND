import { Injectable } from '@nestjs/common';
import { VerificationStatus } from '@common/types/enums';
import type { IVerificationProvider, VerificationInitiateData, VerificationInitiateResult } from './verification-provider.interface';

@Injectable()
export class ManualVerificationProvider implements IVerificationProvider {
  readonly providerName = 'manual';

  async initiate(_data: VerificationInitiateData): Promise<VerificationInitiateResult> {
    return { initialStatus: VerificationStatus.PENDING };
  }
}
