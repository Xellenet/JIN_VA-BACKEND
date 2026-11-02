import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsString, registerDecorator } from 'class-validator';
import type { ValidationOptions } from 'class-validator';
import { normalisePayoutAccountNumber } from '../../payments/payout-account';
import {
  CUSTOMER_MOMO_NUMBER_MESSAGE,
  isGhanaMobileNumber,
  MOMO_PROVIDER_CODES,
} from '../payment-methods.constants';
import type { MomoProviderCode } from '../payment-methods.constants';

function IsGhanaMobileNumber(options?: ValidationOptions) {
  return (object: object, propertyName: string) =>
    registerDecorator({
      name: 'isGhanaMobileNumber',
      target: object.constructor,
      propertyName,
      options: { message: CUSTOMER_MOMO_NUMBER_MESSAGE, ...options },
      validator: { validate: (value: unknown) => isGhanaMobileNumber(value) },
    });
}

/**
 * A customer's mobile money wallet: the network and the number. The body of
 * `POST /users/me/payment-methods/resolve` and `.../mobile-money`. The number
 * is normalised first (`+233 24 000 0000` → `0240000000`) and must have a
 * Ghana mobile prefix of any network (numbers can be ported). Any other key,
 * including a PIN, is refused. Messages never echo the value.
 */
export class MobileMoneyMethodDto {
  @ApiProperty({
    enum: MOMO_PROVIDER_CODES,
    description: "'MTN' | 'VOD' (Telecel) | 'ATL' (AirtelTigo)",
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsIn([...MOMO_PROVIDER_CODES], {
    message: 'Choose MTN, Telecel (VOD) or AirtelTigo (ATL).',
  })
  network!: MomoProviderCode;

  @ApiProperty({ example: '0240000000' })
  @Transform(({ value }: { value: unknown }) =>
    normalisePayoutAccountNumber('mobile_money', value),
  )
  @IsString({ message: CUSTOMER_MOMO_NUMBER_MESSAGE })
  @IsGhanaMobileNumber()
  accountNumber!: string;
}
