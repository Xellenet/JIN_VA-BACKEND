import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PaystackService } from './paystack.service';
import { BankListService } from './bank-list';
import {
  ACCOUNT_LOOKUP_UNAVAILABLE,
  ACCOUNT_NAME_NOT_FOUND,
  UNKNOWN_BANK,
} from './payout-account';
import type { ResolvePayoutAccountDto } from './dto/resolve-payout-account.dto';

/**
 * `POST /payments/payout-method/resolve`: the name on a payout account, so
 * the artisan can confirm it before saving. Validation (number format,
 * MTN/VOD/ATL) is in the DTO; a bank code must also be in the cached bank
 * list. Nothing is logged here: the number and name stay out of the logs.
 */
@Injectable()
export class PayoutAccountService {
  constructor(
    private readonly paystack: PaystackService,
    private readonly banks: BankListService,
  ) {}

  async resolve(
    dto: ResolvePayoutAccountDto,
  ): Promise<{ accountName: string }> {
    if (dto.type === 'bank') {
      let known: boolean;
      try {
        known = (await this.banks.list()).some((b) => b.code === dto.bankCode);
      } catch {
        // No bank list at all: the lookup can't be checked, so it is
        // unavailable, and the artisan can still type the name.
        throw new ServiceUnavailableException(ACCOUNT_LOOKUP_UNAVAILABLE);
      }
      if (!known) throw new BadRequestException(UNKNOWN_BANK);
    }

    const result = await this.paystack.resolveAccount(
      dto.accountNumber,
      dto.bankCode,
    );
    if (result.status === 'resolved') {
      return { accountName: result.accountName };
    }
    if (result.status === 'unresolvable') {
      throw new UnprocessableEntityException(ACCOUNT_NAME_NOT_FOUND);
    }
    throw new ServiceUnavailableException(ACCOUNT_LOOKUP_UNAVAILABLE);
  }
}
