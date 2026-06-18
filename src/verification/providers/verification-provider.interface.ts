import type { DocumentType, VerificationStatus } from '@common/types/enums';

export interface VerificationInitiateData {
  verificationId: number;
  artisanProfileId: number;
  documentType: DocumentType;
  documentFrontUrl: string;
  documentBackUrl?: string;
  selfieUrl: string;
  idNumber?: string;
  fullLegalName?: string;
  dateOfBirth?: string;
}

export interface VerificationInitiateResult {
  initialStatus: VerificationStatus;
  providerReference?: string;
  externalSessionUrl?: string;
  rawResponse?: Record<string, unknown>;
}

export interface IVerificationProvider {
  readonly providerName: string;
  initiate(data: VerificationInitiateData): Promise<VerificationInitiateResult>;
}
