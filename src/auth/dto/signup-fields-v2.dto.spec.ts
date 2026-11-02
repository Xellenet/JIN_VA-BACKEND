import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RegisterUserDto } from './register-user.dto';
import { CompleteSocialSignupDto } from './complete-social-signup.dto';
import { CreateUserDto } from '@users/dto/create-user.dto';
import { UpdateMeDto } from '@users/dto/update-me.dto';
import { UpdateUserDto } from '@users/dto/update-user.dto';
import { VARIABLES } from '@common/constants/variables.constants';

/** Validates the way the global `ValidationPipe` does (whitelist + forbid). */
async function check<T extends object>(
  cls: new () => T,
  body: Record<string, unknown>,
): Promise<{ dto: T; errors: string[] }> {
  const dto = plainToInstance(cls, body);
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { dto, errors: errors.map((e) => e.property) };
}

const register = {
  email: 'ama.reg@example.com',
  password: 'Strong@123',
  username: 'ama.mensah_1',
  firstname: 'Ama',
  lastname: 'Mensah',
  phoneNumber: '024 123 4567',
  gender: 'FEMALE',
};

describe('Sign-up form v2: username rule (new values only)', () => {
  it.each([
    'abc',
    'ama.mensah',
    'ama_mensah',
    'Ama2026',
    '_ama_',
    'a'.repeat(30),
  ])('accepts %p', async (username) => {
    expect(VARIABLES.USERNAME_REGEX.test(username)).toBe(true);
    expect(
      (await check(RegisterUserDto, { ...register, username })).errors,
    ).toEqual([]);
  });

  it.each([
    ['a space', 'ama mensah'],
    ['a leading space', ' ama'],
    ['a trailing space', 'ama '],
    ['a tab', 'ama\tmensah'],
    ['too short', 'ab'],
    ['too long', 'a'.repeat(31)],
    ['a leading dot', '.ama'],
    ['a trailing dot', 'ama.'],
    ['two dots in a row', 'ama..mensah'],
    ['a hyphen', 'ama-mensah'],
    ['an @', 'ama@mensah'],
    ['a non-ASCII letter', 'amá'],
  ])('rejects a username with %s', async (_why, username) => {
    expect(
      (await check(RegisterUserDto, { ...register, username })).errors,
    ).toContain('username');
  });

  it('applies to the admin create and update DTOs too', async () => {
    expect(
      (await check(CreateUserDto, { ...register, username: 'ama mensah' }))
        .errors,
    ).toContain('username');
    expect(
      (await check(UpdateUserDto, { username: 'ama mensah' })).errors,
    ).toContain('username');
  });

  it('PATCH /users/me checks a new username, and leaves an omitted one alone', async () => {
    expect(
      (await check(UpdateMeDto, { username: 'ama mensah' })).errors,
    ).toContain('username');
    expect(
      (await check(UpdateMeDto, { username: 'ama.mensah' })).errors,
    ).toEqual([]);
    // An account whose stored username predates the rule can still save
    // other fields: the client simply doesn't resend the username.
    expect((await check(UpdateMeDto, { firstname: 'Ama' })).errors).toEqual([]);
  });
});

describe('Sign-up form v2: optional middle name', () => {
  it('is optional on register, and absent stays absent', async () => {
    const { dto, errors } = await check(RegisterUserDto, register);
    expect(errors).toEqual([]);
    expect(dto.middlename).toBeUndefined();
  });

  it('is trimmed', async () => {
    const { dto, errors } = await check(RegisterUserDto, {
      ...register,
      middlename: '  Kwame ',
    });
    expect(errors).toEqual([]);
    expect(dto.middlename).toBe('Kwame');
  });

  it.each(['', '   '])('stores blank %p as null', async (middlename) => {
    const { dto, errors } = await check(RegisterUserDto, {
      ...register,
      middlename,
    });
    expect(errors).toEqual([]);
    expect(dto.middlename).toBeNull();
  });

  it('shares the 15-character limit with first and last name', async () => {
    expect(
      (
        await check(RegisterUserDto, {
          ...register,
          middlename: 'a'.repeat(15),
        })
      ).errors,
    ).toEqual([]);
    expect(
      (
        await check(RegisterUserDto, {
          ...register,
          middlename: 'a'.repeat(16),
        })
      ).errors,
    ).toContain('middlename');
    expect(
      (await check(RegisterUserDto, { ...register, middlename: 42 })).errors,
    ).toContain('middlename');
  });

  it('can be set and cleared from PATCH /users/me', async () => {
    const set = await check(UpdateMeDto, { middlename: 'Kwame' });
    expect(set.errors).toEqual([]);
    expect(set.dto.middlename).toBe('Kwame');
    const cleared = await check(UpdateMeDto, { middlename: '' });
    expect(cleared.errors).toEqual([]);
    expect(cleared.dto.middlename).toBeNull();
    expect(
      (await check(UpdateMeDto, { middlename: 'a'.repeat(16) })).errors,
    ).toContain('middlename');
  });

  it('is accepted on the Google completion step with the same rules', async () => {
    const body = {
      role: 'CUSTOMER',
      firstname: 'Ama',
      lastname: 'Mensah',
      phoneNumber: '0241234567',
      gender: 'FEMALE',
    };
    const ok = await check(CompleteSocialSignupDto, {
      ...body,
      middlename: ' Kwame ',
    });
    expect(ok.errors).toEqual([]);
    expect(ok.dto.middlename).toBe('Kwame');
    expect(
      (
        await check(CompleteSocialSignupDto, {
          ...body,
          middlename: 'a'.repeat(16),
        })
      ).errors,
    ).toContain('middlename');
  });
});

describe('Sign-up form v2: a trunk 0 after the calling code is dropped', () => {
  it.each([
    ['+233 024 123 4567', '+233241234567'],
    ['+2330241234567', '+233241234567'],
    ['2330241234567', '+233241234567'],
    ['00233 024 123 4567', '+233241234567'],
    ['+234 0803 123 4567', '+2348031234567'],
  ])('stores %p as %p', async (phoneNumber, expected) => {
    const { dto, errors } = await check(RegisterUserDto, {
      ...register,
      phoneNumber,
    });
    expect(errors).toEqual([]);
    expect(dto.phoneNumber).toBe(expected);
  });

  it('keeps a leading 0 that is part of the number (Côte d’Ivoire)', async () => {
    const { dto, errors } = await check(UpdateMeDto, {
      phoneNumber: '+225 01 23 45 6789',
    });
    expect(errors).toEqual([]);
    expect(dto.phoneNumber).toBe('+2250123456789');
  });
});
