import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsString } from 'class-validator';
import {
  normalisePayoutAccountNumber,
  normalisePayoutBankCode,
} from '../payout-account';
import {
  IsPayoutAccountNumber,
  IsPayoutBankCode,
} from './payout-account.validators';

type WithType = { type?: unknown };

/**
 * A payout destination: the network or bank and the number. The body of
 * `POST /payments/payout-method/resolve`, and the base of the save DTO.
 * The number is normalised before validation (`+233 24 123 4567` →
 * `0241234567`).
 */
export class ResolvePayoutAccountDto {
  @ApiProperty({
    enum: ['mobile_money', 'bank'],
    description:
      'mobile_money for MTN/Telecel/AirtelTigo, bank for bank account',
  })
  // QA PAY-13: IsEnum with an array printed "must be one of the following
  // values: " with an empty list.
  @IsIn(['mobile_money', 'bank'], {
    message: 'type must be mobile_money or bank',
  })
  type!: 'mobile_money' | 'bank';

  @ApiProperty({
    description:
      'Mobile money: a Ghana number, 10 digits starting with 0 (+233/233 is accepted and normalised). Bank: 6–20 digits.',
    example: '0241234567',
  })
  @Transform(({ value, obj }: { value: unknown; obj: WithType }) =>
    normalisePayoutAccountNumber(obj?.type, value),
  )
  @IsString()
  @IsPayoutAccountNumber()
  accountNumber!: string;

  @ApiProperty({
    description:
      "Mobile money: 'MTN' | 'VOD' (Telecel) | 'ATL' (AirtelTigo). Bank: the Paystack bank code from GET /payments/banks.",
    examples: {
      mtn: { value: 'MTN' },
      telecel: { value: 'VOD' },
      airtelTigo: { value: 'ATL' },
    },
  })
  @Transform(({ value, obj }: { value: unknown; obj: WithType }) =>
    normalisePayoutBankCode(obj?.type, value),
  )
  @IsString()
  @IsPayoutBankCode()
  bankCode!: string;
}
