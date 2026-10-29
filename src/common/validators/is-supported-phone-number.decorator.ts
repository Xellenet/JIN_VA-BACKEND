import { Transform } from 'class-transformer';
import { registerDecorator, ValidationOptions } from 'class-validator';
import { VALIDATION_MESSAGES } from '@common/constants/validation-messages.constants';
import {
  isSupportedPhoneNumber,
  normalizePhoneNumberInput,
} from '@common/utils/phone-number.util';

/**
 * PH7: normalises a phone field to E.164 before validation (`+233241234567`
 * from `024 123 4567`, `+233 24 123 4567`, `00233…`). National input is read
 * as Ghanaian. Input that doesn't parse to a valid number is left as sent, so
 * {@link IsSupportedPhoneNumber} rejects it.
 *
 * Requires the `ValidationPipe`'s class-transformer step (always on) — and
 * `transform: true` (set in `main.ts`) for the normalised value to reach the
 * handler, which is what makes every stored number E.164.
 */
export function NormalizePhoneNumber(): PropertyDecorator {
  return Transform(({ value }: { value: unknown }) =>
    normalizePhoneNumberInput(value),
  );
}

/**
 * PH7: a valid phone number (per `libphonenumber-js/max`) from a country in
 * `SUPPORTED_PHONE_COUNTRIES`. Replaces the old US-only `XXX-XXX-XXXX` regex.
 */
export function IsSupportedPhoneNumber(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isSupportedPhoneNumber',
      target: object.constructor,
      propertyName,
      options: {
        message: VALIDATION_MESSAGES.PHONE_NUMBER_INVALID,
        ...validationOptions,
      },
      validator: {
        validate(value: unknown) {
          return isSupportedPhoneNumber(value);
        },
      },
    });
  };
}
