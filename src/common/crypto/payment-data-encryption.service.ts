import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  FieldCipher,
  FieldEncryptionError,
  fieldCipherFromConfig,
} from './field-encryption';

export const PAYMENT_DATA_KEY_ENV = 'PAYMENT_DATA_ENCRYPTION_KEY';
export const PAYMENT_DATA_PREVIOUS_KEY_ENV =
  'PAYMENT_DATA_ENCRYPTION_KEY_PREVIOUS';

/** `meta.error` on the 503 a caller gets while saving is switched off. */
export const PAYMENT_METHODS_DISABLED = 'PAYMENT_METHODS_DISABLED';
export const PAYMENT_METHODS_DISABLED_MESSAGE =
  "Saving payment methods isn't available right now. You can still pay another way.";

/**
 * The application's payment-data cipher, built once from configuration.
 *
 * Optional by design: with no `PAYMENT_DATA_ENCRYPTION_KEY` (or a malformed
 * one) the app still starts, one warning is logged, and every feature that
 * needs it answers 503 (`assertEnabled`). Values are never logged.
 */
@Injectable()
export class PaymentDataEncryptionService {
  private readonly logger = new Logger(PaymentDataEncryptionService.name);
  private readonly cipher: FieldCipher | null;

  constructor(config: ConfigService) {
    let cipher: FieldCipher | null = null;
    try {
      cipher = fieldCipherFromConfig(
        config.get<string>(PAYMENT_DATA_KEY_ENV),
        config.get<string>(PAYMENT_DATA_PREVIOUS_KEY_ENV),
      );
      if (!cipher) {
        this.logger.warn(
          `${PAYMENT_DATA_KEY_ENV} is not set: saved payment methods are disabled.`,
        );
      }
    } catch (err) {
      this.logger.error(
        `${PAYMENT_DATA_KEY_ENV} is invalid (${
          err instanceof FieldEncryptionError ? err.message : 'unreadable'
        }): saved payment methods are disabled.`,
      );
      cipher = null;
    }
    this.cipher = cipher;
  }

  isEnabled(): boolean {
    return this.cipher !== null;
  }

  /** Throws the 503 every saved-method endpoint answers while disabled. */
  assertEnabled(): FieldCipher {
    if (!this.cipher) {
      throw new ServiceUnavailableException({
        errorCode: PAYMENT_METHODS_DISABLED,
        message: PAYMENT_METHODS_DISABLED_MESSAGE,
      });
    }
    return this.cipher;
  }

  encrypt(plaintext: string): string {
    return this.assertEnabled().encrypt(plaintext);
  }

  decrypt(payload: string): string {
    return this.assertEnabled().decrypt(payload);
  }

  hash(value: string): string {
    return this.assertEnabled().hash(value);
  }

  hashCandidates(value: string): string[] {
    return this.assertEnabled().hashCandidates(value);
  }
}
