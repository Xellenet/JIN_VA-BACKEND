import { plainToInstance } from 'class-transformer';
import { IsOptional, IsString, validate } from 'class-validator';
import type { CountryCode } from 'libphonenumber-js/max';
import {
  isSupportedPhoneNumber,
  normalizePhoneNumberInput,
  toE164PhoneNumber,
} from './phone-number.util';
import { PHONE_NUMBER_FIXTURES } from './phone-number.fixtures';
import {
  IsSupportedPhoneNumber,
  NormalizePhoneNumber,
} from '@common/validators/is-supported-phone-number.decorator';
import { SUPPORTED_PHONE_COUNTRIES } from '@common/constants/supported-phone-countries.constants';

describe('phone-number.util (PH7/PH8)', () => {
  describe('shared fixture table', () => {
    it.each(PHONE_NUMBER_FIXTURES.map((f) => [f.note, f]))(
      '%s',
      (_note, { input, country, expected }) => {
        const cc = country as CountryCode;
        expect(isSupportedPhoneNumber(input, cc)).toBe(expected !== null);
        if (expected !== null) {
          expect(toE164PhoneNumber(input, cc)).toBe(expected);
        }
      },
    );
  });

  it('pins Ghana first in the 16-country launch list (Q9)', () => {
    expect(SUPPORTED_PHONE_COUNTRIES[0]).toBe('GH');
    expect(SUPPORTED_PHONE_COUNTRIES).toHaveLength(16);
    expect(new Set(SUPPORTED_PHONE_COUNTRIES).size).toBe(16);
  });

  describe('normalizePhoneNumberInput', () => {
    it('normalises national Ghana input to E.164', () => {
      expect(normalizePhoneNumberInput(' 024 123 4567 ')).toBe('+233241234567');
    });

    it.each([undefined, null, 241234567, '', '   ', 'garbage', '123-456-7890'])(
      'leaves %p unchanged for the validator to reject',
      (value) => {
        expect(normalizePhoneNumberInput(value)).toBe(value);
      },
    );
  });

  describe('decorators', () => {
    class Body {
      @IsOptional()
      @IsString()
      @NormalizePhoneNumber()
      @IsSupportedPhoneNumber()
      phoneNumber?: string;
    }

    const run = async (phoneNumber: unknown) => {
      const dto = plainToInstance(Body, { phoneNumber });
      return { dto, errors: await validate(dto) };
    };

    it('stores the normalised value and passes', async () => {
      const { dto, errors } = await run('+233 24 123 4567');
      expect(errors).toEqual([]);
      expect(dto.phoneNumber).toBe('+233241234567');
    });

    it('rejects an unsupported country with the developer message', async () => {
      const { errors } = await run('+44 7911 123456');
      expect(errors[0].constraints?.isSupportedPhoneNumber).toBe(
        'phoneNumber must be a valid phone number for a supported country',
      );
    });
  });
});
