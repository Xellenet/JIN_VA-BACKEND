import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RegisterUserDto } from './register-user.dto';
import { CreateUserDto } from '@users/dto/create-user.dto';
import { UpdateMeDto } from '@users/dto/update-me.dto';

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
  email: 'reg@example.com',
  password: 'Strong@123',
  username: 'reguser',
  firstname: 'Reg',
  lastname: 'User',
  phoneNumber: '024 123 4567',
  gender: 'FEMALE',
};

describe('RegisterUserDto (PH6, PH7, DI5)', () => {
  it('accepts a complete body and stores the phone as E.164', async () => {
    const { dto, errors } = await check(RegisterUserDto, register);
    expect(errors).toEqual([]);
    expect(dto.phoneNumber).toBe('+233241234567');
  });

  it.each(['phoneNumber', 'gender'])('requires %s', async (field) => {
    const body: Record<string, unknown> = { ...register };
    delete body[field];
    expect((await check(RegisterUserDto, body)).errors).toContain(field);
  });

  it.each([
    ['phoneNumber', '123-456-7890'],
    ['phoneNumber', '+44 7911 123456'],
    ['phoneNumber', ''],
    ['gender', 'OTHER'],
  ])('rejects %s = %p', async (field, value) => {
    expect(
      (await check(RegisterUserDto, { ...register, [field]: value })).errors,
    ).toContain(field);
  });

  it('keeps every other CreateUserDto rule (e.g. the email check)', async () => {
    expect(
      (await check(RegisterUserDto, { ...register, email: 'nope' })).errors,
    ).toContain('email');
  });
});

describe('CreateUserDto (shared; phone and gender stay optional)', () => {
  const { phoneNumber: _p, gender: _g, ...minimal } = register;
  void _p;
  void _g;

  it('still accepts a body with no phone or gender', async () => {
    expect((await check(CreateUserDto, minimal)).errors).toEqual([]);
  });

  it('normalises a phone when given, and rejects OTHER', async () => {
    const ok = await check(CreateUserDto, {
      ...minimal,
      phoneNumber: '+233 24 123 4567',
    });
    expect(ok.errors).toEqual([]);
    expect(ok.dto.phoneNumber).toBe('+233241234567');
    expect(
      (await check(CreateUserDto, { ...minimal, gender: 'OTHER' })).errors,
    ).toContain('gender');
  });
});

describe('UpdateMeDto (PH6, PH7, DI5)', () => {
  it('leaves an omitted phone/gender alone', async () => {
    const { dto, errors } = await check(UpdateMeDto, { firstname: 'Ama' });
    expect(errors).toEqual([]);
    expect(dto.phoneNumber).toBeUndefined();
  });

  it('normalises a present phone to E.164, including another supported country', async () => {
    const intl = await check(UpdateMeDto, { phoneNumber: '+234 803 123 4567' });
    expect(intl.errors).toEqual([]);
    expect(intl.dto.phoneNumber).toBe('+2348031234567');
  });

  it('reads national input as Ghanaian, so a Nigerian national number is rejected', async () => {
    expect(
      (await check(UpdateMeDto, { phoneNumber: '0803 123 4567' })).errors,
    ).toContain('phoneNumber');
  });

  it.each(['OTHER', 'female'])('rejects gender %p', async (gender) => {
    expect((await check(UpdateMeDto, { gender })).errors).toContain('gender');
  });

  it('accepts MALE and FEMALE', async () => {
    for (const gender of ['MALE', 'FEMALE']) {
      expect((await check(UpdateMeDto, { gender })).errors).toEqual([]);
    }
  });
});
