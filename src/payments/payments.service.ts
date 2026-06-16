import { Injectable, Logger } from '@nestjs/common';

/**
 * Mock payment service. All methods simulate payment operations and log the
 * intent to the console. Replace the bodies with real Stripe (or other provider)
 * SDK calls when the payment integration phase begins.
 *
 * Integration notes (Stripe):
 *  - holdPayment   → createPaymentIntent({ capture_method: 'manual' })
 *  - capturePayment → paymentIntents.capture(intentId)
 *  - cancelPayment  → paymentIntents.cancel(intentId)
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  /**
   * Places a hold (authorisation) on the customer's payment method for the job amount.
   * Funds are reserved but not yet transferred to the artisan.
   *
   * @param jobId - The job the payment is associated with.
   * @param customerId - The customer whose payment method is being charged.
   * @param amount - The agreed quote price (optional at this stage).
   * @returns A mock payment-intent ID that must be stored on the job for later capture/cancel.
   */
  async holdPayment(jobId: number, customerId: number, amount?: number): Promise<string> {
    const mockIntentId = `pi_mock_job${jobId}_cust${customerId}`;
    this.logger.warn(
      `[MOCK PAYMENT] HOLD — job=${jobId} customer=${customerId} amount=${amount ?? 'unspecified'} → ${mockIntentId}`,
    );
    return mockIntentId;
  }

  /**
   * Captures a previously held payment, releasing the funds to the artisan
   * (minus the platform fee). Called when the customer confirms job completion.
   *
   * @param paymentIntentId - The ID returned by {@link holdPayment}.
   * @param jobId - Used for logging/audit context.
   */
  async capturePayment(paymentIntentId: string, jobId: number): Promise<void> {
    this.logger.warn(
      `[MOCK PAYMENT] CAPTURE — job=${jobId} intent=${paymentIntentId}`,
    );
  }

  /**
   * Cancels a held payment, fully refunding the customer.
   * Called when a job is cancelled after the payment hold was placed.
   *
   * @param paymentIntentId - The ID returned by {@link holdPayment}.
   * @param jobId - Used for logging/audit context.
   */
  async cancelPayment(paymentIntentId: string, jobId: number): Promise<void> {
    this.logger.warn(
      `[MOCK PAYMENT] CANCEL — job=${jobId} intent=${paymentIntentId}`,
    );
  }
}
