import { ValidationPipe, BadRequestException } from '@nestjs/common';
import type { ArgumentMetadata } from '@nestjs/common';
import { UpdatePaymentSettingsDto } from './update-payment-settings.dto';

/** The same pipe options as `src/main.ts`. */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
const meta: ArgumentMetadata = {
  type: 'body',
  metatype: UpdatePaymentSettingsDto,
};

async function validate(body: unknown) {
  return pipe.transform(body, meta) as Promise<UpdatePaymentSettingsDto>;
}

async function messagesFor(body: unknown): Promise<string[]> {
  try {
    await validate(body);
  } catch (err) {
    const response = (err as BadRequestException).getResponse() as {
      message: string[];
    };
    return response.message;
  }
  return [];
}

describe('UpdatePaymentSettingsDto (BU-5.3, PR-1)', () => {
  it('accepts an empty body', async () => {
    await expect(validate({})).resolves.toEqual({});
  });

  it('accepts valid values and null to clear', async () => {
    await expect(
      validate({ preferredChannel: 'card', momoNetwork: 'MTN' }),
    ).resolves.toEqual({ preferredChannel: 'card', momoNetwork: 'MTN' });
    await expect(
      validate({ preferredChannel: null, momoNetwork: null }),
    ).resolves.toEqual({ preferredChannel: null, momoNetwork: null });
  });

  it.each([
    [{ preferredChannel: 'bank_transfer' }],
    [{ preferredChannel: 'MOBILE_MONEY' }],
    [{ momoNetwork: 'VODAFONE' }],
    [{ momoNetwork: 'mtn' }],
    [{ userId: 5 }],
    [{ customerId: 5 }],
    [{ momoNumber: '+233241234567' }],
    [{ channels: ['card'] }],
    [{ currentPassword: 'x' }],
  ])('rejects %p', async (body) => {
    await expect(validate(body)).rejects.toThrow(BadRequestException);
  });

  it('never echoes the submitted value in a message (SEC-31)', async () => {
    const messages = await messagesFor({
      preferredChannel: 'tracker-value-123',
      momoNetwork: 'tracker-value-456',
    });
    expect(messages.length).toBe(2);
    for (const message of messages) {
      expect(message).not.toContain('tracker-value');
    }
  });
});
