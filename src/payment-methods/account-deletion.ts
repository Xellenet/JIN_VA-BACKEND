import type { EntityManager } from 'typeorm';
import { AccountSecurityEvent } from '../account-security/entities/account-security-event.entity';
import { PaymentAttemptsService } from '../payments/payment-attempts.service';
import { CustomerPaymentMethod } from './entities/customer-payment-method.entity';

export interface PaymentDataRemoval {
  methodsRemoved: number;
  attemptsCancelled: number;
}

/**
 * A customer asked to close their account: their saved payment methods
 * (encrypted numbers and card authorizations) are deleted at once, inside
 * the deletion request's transaction, rather than waiting for the purge 30
 * days later (which still deletes any that remain, as a safety net).
 * Active payment attempts are cancelled and any save-card opt-in is
 * withdrawn, so nothing in flight can become a saved card. One security
 * event records it (counts only). Restoring the account does not bring the
 * methods back; the customer adds them again.
 */
export async function removePaymentDataOnDeletionRequest(
  manager: EntityManager,
  userId: number,
): Promise<PaymentDataRemoval> {
  const removed = await manager
    .getRepository(CustomerPaymentMethod)
    .delete({ userId });
  const methodsRemoved = removed?.affected ?? 0;
  const attemptsCancelled =
    await PaymentAttemptsService.cancelForAccountDeletion(manager, userId);
  if (methodsRemoved > 0 || attemptsCancelled > 0) {
    await manager.getRepository(AccountSecurityEvent).insert({
      userId,
      event: 'payment_method.removed',
      fieldsChanged: [],
      details: {
        reason: 'account_deletion',
        count: methodsRemoved,
        attemptsCancelled,
      },
    });
  }
  return { methodsRemoved, attemptsCancelled };
}
