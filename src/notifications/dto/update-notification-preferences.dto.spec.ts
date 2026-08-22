import {
  ArgumentMetadata,
  BadRequestException,
  ValidationPipe,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { AdminNotificationPreferencesResponseDto } from './admin-notification-preferences-response.dto';
import { ArtisanNotificationPreferencesResponseDto } from './artisan-notification-preferences-response.dto';
import { CustomerNotificationPreferencesResponseDto } from './customer-notification-preferences-response.dto';
import { UpdateNotificationPreferencesDto } from './update-notification-preferences.dto';

/**
 * QA M1: the artisan settings screen round-trips the whole `GET
 * /notifications/preferences` body straight back into the `PATCH`, so any key a
 * response DTO exposes but `UpdateNotificationPreferencesDto` omits makes the
 * *entire* save 400 under the global
 * `ValidationPipe({ whitelist, forbidNonWhitelisted })` — `bookingReminders`
 * did exactly that and no artisan could save any preference at all.
 *
 * This suite guards the class of bug, not just the one key: it derives the
 * exposed keys from each role's response DTO and drives them through a pipe
 * configured identically to `main.ts`, so adding a response field without the
 * matching update field fails here instead of in the product.
 */
describe('UpdateNotificationPreferencesDto ← preference response DTOs', () => {
  // Same options as the global pipe in `src/main.ts`.
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });

  const metadata: ArgumentMetadata = {
    type: 'body',
    metatype: UpdateNotificationPreferencesDto,
  };

  /** The keys `@Expose()`d by a response DTO, as the client receives them. */
  const exposedKeys = (dto: new () => object): string[] =>
    Object.keys(plainToInstance(dto, {}, { excludeExtraneousValues: true }));

  /** What the settings screens send: the GET body minus its `id` metadata. */
  const roundTripPayload = (dto: new () => object): Record<string, boolean> =>
    Object.fromEntries(
      exposedKeys(dto)
        .filter((key) => key !== 'id')
        .map((key) => [key, true]),
    );

  const roles: [string, new () => object][] = [
    ['artisan', ArtisanNotificationPreferencesResponseDto],
    ['customer', CustomerNotificationPreferencesResponseDto],
    ['admin', AdminNotificationPreferencesResponseDto],
  ];

  it.each(roles)(
    'accepts the full %s GET body PATCHed straight back',
    async (_role, dto) => {
      const payload = roundTripPayload(dto);

      // Sanity: the payload is really the response shape, not an empty object.
      expect(Object.keys(payload).length).toBeGreaterThan(5);

      await expect(pipe.transform(payload, metadata)).resolves.toEqual(
        expect.objectContaining(payload),
      );
    },
  );

  it('accepts bookingReminders — the key that broke every artisan save', async () => {
    await expect(
      pipe.transform({ bookingReminders: false }, metadata),
    ).resolves.toEqual(
      expect.objectContaining({ bookingReminders: false }) as object,
    );
  });

  /** The pipe throws a BadRequestException whose body carries the real reasons. */
  const rejectionReasons = async (
    payload: Record<string, unknown>,
  ): Promise<string> => {
    try {
      await pipe.transform(payload, metadata);
    } catch (error) {
      const body = (error as BadRequestException).getResponse() as {
        message?: string[] | string;
      };
      const message = body.message ?? '';
      return Array.isArray(message) ? message.join(' | ') : message;
    }
    throw new Error('expected the validation pipe to reject this payload');
  };

  it('still rejects a key no role exposes, so whitelisting is intact', async () => {
    await expect(
      rejectionReasons({ notARealPreference: true }),
    ).resolves.toMatch(/property notARealPreference should not exist/);
  });

  it('still rejects a non-boolean value for a known key', async () => {
    await expect(rejectionReasons({ messageReceived: 'yes' })).resolves.toMatch(
      /boolean/,
    );
  });
});
