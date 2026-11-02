import { registerDecorator } from 'class-validator';
import type { ValidationArguments, ValidationOptions } from 'class-validator';
import {
  BANK_ACCOUNT_NUMBER_MESSAGE,
  MOBILE_MONEY_NUMBER_MESSAGE,
  isValidPayoutAccountNumber,
  isValidPayoutBankCode,
} from '../payout-account';

const typeOf = (args: ValidationArguments): unknown =>
  (args.object as { type?: unknown }).type;

/** The number must fit the payout `type` on the same object (see payout-account.ts). */
export function IsPayoutAccountNumber(options?: ValidationOptions) {
  return (object: object, propertyName: string) =>
    registerDecorator({
      name: 'isPayoutAccountNumber',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate: (value: unknown, args: ValidationArguments) =>
          isValidPayoutAccountNumber(typeOf(args), value),
        defaultMessage: (args: ValidationArguments) =>
          typeOf(args) === 'bank'
            ? BANK_ACCOUNT_NUMBER_MESSAGE
            : MOBILE_MONEY_NUMBER_MESSAGE,
      },
    });
}

/** The code must fit the payout `type`: MTN/VOD/ATL, or a bank code. */
export function IsPayoutBankCode(options?: ValidationOptions) {
  return (object: object, propertyName: string) =>
    registerDecorator({
      name: 'isPayoutBankCode',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate: (value: unknown, args: ValidationArguments) =>
          isValidPayoutBankCode(typeOf(args), value),
        defaultMessage: (args: ValidationArguments) =>
          typeOf(args) === 'bank'
            ? 'Choose a bank from the list.'
            : 'Choose MTN, Telecel (VOD) or AirtelTigo (ATL).',
      },
    });
}
