import { BadRequestException, ValidationPipe } from '@nestjs/common';
import type { ArgumentMetadata } from '@nestjs/common';
import { UpdateMeDto } from './update-me.dto';

/** The same pipe options as `src/main.ts`. */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
const meta: ArgumentMetadata = { type: 'body', metatype: UpdateMeDto };

describe('UpdateMeDto (BU-3.4 / T-10)', () => {
  it('rejects profilePicture, so a client cannot point its avatar anywhere', async () => {
    await expect(
      pipe.transform(
        { profilePicture: 'https://tracker.example.com/p.gif' },
        meta,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects profilePicture even with our own avatar path', async () => {
    await expect(
      pipe.transform({ profilePicture: '/uploads/avatars/a.webp' }, meta),
    ).rejects.toThrow(BadRequestException);
  });

  it('still accepts the other profile fields', async () => {
    await expect(
      pipe.transform({ firstname: 'Ama', lastname: 'Owusu' }, meta),
    ).resolves.toEqual({ firstname: 'Ama', lastname: 'Owusu' });
  });
});
