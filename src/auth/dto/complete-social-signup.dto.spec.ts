import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Role } from '@common/types/enums';
import { CompleteSocialSignupDto } from './complete-social-signup.dto';

/** Validates the way the global `ValidationPipe` does (whitelist + forbid). */
const errorsFor = async (body: Record<string, unknown>): Promise<string[]> => {
  const dto = plainToInstance(CompleteSocialSignupDto, body);
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errors.map((e) => e.property);
};

describe('CompleteSocialSignupDto', () => {
  const customer = {
    role: Role.CUSTOMER,
    firstname: 'Ama',
    lastname: 'Owusu',
    phoneNumber: '024 555 1234',
    gender: 'FEMALE',
  };
  const artisan = {
    ...customer,
    role: Role.ARTISAN,
    serviceIds: [1, 2],
    location: 'Accra',
    hourlyRate: 45.5,
    bio: 'Plumber.',
  };

  it('accepts a minimal CUSTOMER', async () => {
    expect(await errorsFor(customer)).toEqual([]);
  });

  it('accepts a CUSTOMER with an optional date of birth', async () => {
    expect(
      await errorsFor({
        ...customer,
        dateOfBirth: '1995-10-25',
      }),
    ).toEqual([]);
  });

  it('accepts a complete ARTISAN, with and without the optional extras', async () => {
    expect(await errorsFor(artisan)).toEqual([]);
    expect(
      await errorsFor({
        ...artisan,
        businessName: 'Owusu Ltd',
        experienceYears: 0,
      }),
    ).toEqual([]);
  });

  it.each([undefined, 'ADMIN', 'customer', 'SUPERUSER'])(
    'rejects role %p',
    async (role) => {
      expect(await errorsFor({ ...customer, role })).toContain('role');
    },
  );

  it.each(['firstname', 'lastname', 'phoneNumber', 'gender'])(
    'requires %s',
    async (field) => {
      const body: Record<string, unknown> = { ...customer };
      delete body[field];
      expect(await errorsFor(body)).toContain(field);
    },
  );

  it('rejects blank names', async () => {
    const errors = await errorsFor({
      ...customer,
      firstname: '   ',
      lastname: '',
    });
    expect(errors).toEqual(expect.arrayContaining(['firstname', 'lastname']));
  });

  // PH2/PH7: every accepted form is stored as E.164.
  it.each([
    '0241234567',
    '024 123 4567',
    '24 123 4567',
    '+233 24 123 4567',
    '+2330241234567',
    '00233 24 123 4567',
  ])('accepts %p and normalises it to +233241234567', async (phoneNumber) => {
    const dto = plainToInstance(CompleteSocialSignupDto, {
      ...customer,
      phoneNumber,
    });
    expect(await validate(dto)).toEqual([]);
    expect(dto.phoneNumber).toBe('+233241234567');
  });

  it.each([
    '123-456-7890',
    '024123456',
    '0251234567',
    '+44 7911 123456',
    'not a number',
    '',
  ])('rejects phone number %p', async (phoneNumber) => {
    expect(await errorsFor({ ...customer, phoneNumber })).toContain(
      'phoneNumber',
    );
  });

  // DI5: OTHER stays in the enum for existing rows but is not new input.
  it.each(['OTHER', 'male', 'UNSPECIFIED', ''])(
    'rejects gender %p',
    async (gender) => {
      expect(await errorsFor({ ...customer, gender })).toContain('gender');
    },
  );

  it('accepts MALE', async () => {
    expect(await errorsFor({ ...customer, gender: 'MALE' })).toEqual([]);
  });

  it('requires every searchable-profile field for an ARTISAN, but not a bio (B1)', async () => {
    const errors = await errorsFor({ ...customer, role: Role.ARTISAN });
    expect(errors).toEqual(
      expect.arrayContaining(['serviceIds', 'location', 'hourlyRate']),
    );
    expect(errors).not.toContain('bio');
  });

  it.each([undefined, '', '   '])(
    'accepts an ARTISAN with bio %p and drops it (stored as null, B1)',
    async (bio) => {
      const dto = plainToInstance(CompleteSocialSignupDto, { ...artisan, bio });
      expect(await validate(dto)).toEqual([]);
      expect(dto.bio).toBeUndefined();
    },
  );

  it.each([
    ['serviceIds', []],
    ['serviceIds', ['1']],
    ['location', '  '],
    ['hourlyRate', 0],
    ['hourlyRate', -5],
    ['hourlyRate', 1.234],
    ['bio', 'x'.repeat(1001)],
    ['experienceYears', -1],
    ['experienceYears', 2.5],
  ])('rejects ARTISAN %s = %p', async (field, value) => {
    expect(await errorsFor({ ...artisan, [field]: value })).toContain(field);
  });

  it('does not validate artisan-only fields on a CUSTOMER (they are ignored)', async () => {
    expect(
      await errorsFor({ ...customer, serviceIds: [], hourlyRate: -1, bio: '' }),
    ).toEqual([]);
  });

  it('rejects unknown properties, like every other body', async () => {
    expect(await errorsFor({ ...customer, password: 'x' })).toContain(
      'password',
    );
  });
});
