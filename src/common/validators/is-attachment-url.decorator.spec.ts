import {
  ArgumentMetadata,
  BadRequestException,
  ValidationPipe,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { SendMessageDto } from '../../messages/dto/send-message.dto';
import { CreateReviewDto } from '../../reviews/dto/create-review.dto';
import { CreateJobDto } from '../../jobs/dto/create-job.dto';
import { CreateBookingDto } from '../../bookings/dto/create-booking.dto';

/**
 * QA `qa-report.md` B2 (major) / security `security-report.md` B6: the local
 * branch of `@IsAttachmentUrl` used to be a bare
 * `value.startsWith('/uploads/')`, so a sender could attach any path under the
 * uploads tree — another folder (`documents/` KYC material, `profiles/`,
 * `portfolio/`), a `../`/`%2e%2e` traversal string, a query string, or a file
 * that never existed — and it was persisted and rendered, including in the
 * admin dispute-evidence viewer. `api-contract.md` §3 promised the opposite.
 *
 * This suite is the regression guard for that promise. It drives the real DTOs
 * (not a synthetic one) so the folder each field is pinned to is asserted too,
 * and it reproduces QA's accepted/rejected table row for row.
 */
describe('IsAttachmentUrl', () => {
  const UUID = '3f1e6c1a-1c2b-4d8e-9a7f-0b1c2d3e4f56';
  const UUID_2 = 'fc4ad108-9b0e-4c31-8a2d-35e84ec6b1a7';

  /** Does `value` produce a validation error on `property` of `dto`? */
  const rejects = (
    dto: new () => object,
    property: string,
    value: unknown,
  ): boolean =>
    validateSync(plainToInstance(dto, { [property]: value }), {
      skipMissingProperties: true,
    }).some((error) => error.property === property);

  const accepts = (dto: new () => object, property: string, value: unknown) =>
    !rejects(dto, property, value);

  describe('messages — POST /messages attachmentUrl', () => {
    const check = (value: unknown) =>
      accepts(SendMessageDto, 'attachmentUrl', value);

    it.each([
      [`/uploads/messages/${UUID}.jpg`],
      [`/uploads/messages/${UUID_2}.png`],
    ])('accepts %s (what POST /uploads/message-attachment returns)', (url) => {
      expect(check(url)).toBe(true);
    });

    it.each([
      // Other folders under the same uploads root — the core of QA B2.
      [`/uploads/documents/${UUID}.pdf`],
      [`/uploads/selfies/${UUID}.jpg`],
      [`/uploads/profiles/ama-mensah.jpg`],
      [`/uploads/portfolio/${UUID}.jpg`],
      [`/uploads/reviews/${UUID}.jpg`],
      [`/uploads/job-attachments/${UUID}.jpg`],
      // Traversal, raw and percent-encoded.
      [`/uploads/messages/../documents/secret.pdf`],
      [`/uploads/messages/%2e%2e/documents/secret.pdf`],
      [`/uploads/../../etc/passwd`],
      [`/uploads/messages/..%2fdocuments%2fsecret.pdf`],
      // A filename the provider could never have minted.
      [`/uploads/messages/does-not-exist.jpg`],
      [`/uploads/messages/${UUID.toUpperCase()}.jpg`],
      [`/uploads/messages/${UUID}.JPG`],
      // Extensions the message-attachment endpoint cannot produce.
      [`/uploads/messages/${UUID}.svg`],
      [`/uploads/messages/${UUID}.pdf`],
      [`/uploads/messages/${UUID}.webp`],
      // Query string / fragment smuggling.
      [`/uploads/messages/${UUID}.jpg?<script>alert(1)</script>`],
      [`/uploads/messages/${UUID}.jpg#frag`],
      // Nested path under the right folder.
      [`/uploads/messages/nested/${UUID}.jpg`],
      // Not our origin at all.
      ['//evil.example/x.png'],
      [`http://localhost:8011/uploads/messages/${UUID}.jpg`],
      ['https://evil.example.com/payload.jpg'],
      ['javascript:alert(1)'],
      ['data:image/png;base64,AAAA'],
      ['pipe.png'],
      [''],
    ])('rejects %s', (url) => {
      expect(check(url)).toBe(false);
    });

    it('rejects a forged path through the global ValidationPipe, with display-safe copy', async () => {
      const pipe = new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      });
      const metadata: ArgumentMetadata = {
        type: 'body',
        metatype: SendMessageDto,
      };

      await expect(
        pipe.transform(
          {
            recipientId: 5,
            content: 'probe',
            attachmentUrl: '/uploads/documents/some-kyc-doc.pdf',
          },
          metadata,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      await expect(
        pipe.transform(
          {
            recipientId: 5,
            content: 'probe',
            attachmentUrl: `/uploads/messages/${UUID}.png`,
          },
          metadata,
        ),
      ).resolves.toMatchObject({
        attachmentUrl: `/uploads/messages/${UUID}.png`,
      });
    });
  });

  /**
   * The decorator is shared with reviews, jobs and bookings, so each of those
   * needs to keep accepting its own folder and start rejecting the others.
   */
  describe('the other three call sites stay pinned to their own folder', () => {
    it('reviews accept /uploads/reviews and reject message/job folders', () => {
      expect(
        accepts(CreateReviewDto, 'photoUrls', [
          `/uploads/reviews/${UUID}.jpg`,
          `/uploads/reviews/${UUID_2}.png`,
        ]),
      ).toBe(true);
      expect(
        rejects(CreateReviewDto, 'photoUrls', [
          `/uploads/messages/${UUID}.jpg`,
        ]),
      ).toBe(true);
      expect(
        rejects(CreateReviewDto, 'photoUrls', [
          `/uploads/documents/${UUID}.pdf`,
        ]),
      ).toBe(true);
      expect(
        rejects(CreateReviewDto, 'photoUrls', [
          `/uploads/reviews/${UUID}.jpg`,
          '/uploads/reviews/../documents/x.pdf',
        ]),
      ).toBe(true);
    });

    it('jobs accept /uploads/job-attachments and reject other folders', () => {
      expect(
        accepts(CreateJobDto, 'attachmentUrls', [
          `/uploads/job-attachments/${UUID}.webp`,
        ]),
      ).toBe(true);
      expect(
        rejects(CreateJobDto, 'attachmentUrls', [
          `/uploads/messages/${UUID}.jpg`,
        ]),
      ).toBe(true);
      expect(
        rejects(CreateJobDto, 'attachmentUrls', [
          `/uploads/selfies/${UUID}.jpg`,
        ]),
      ).toBe(true);
    });

    it('bookings accept the same job-attachment folder they share with jobs', () => {
      expect(
        accepts(CreateBookingDto, 'attachmentUrls', [
          `/uploads/job-attachments/${UUID}.png`,
        ]),
      ).toBe(true);
      expect(
        rejects(CreateBookingDto, 'attachmentUrls', [
          `/uploads/documents/${UUID}.pdf`,
        ]),
      ).toBe(true);
    });
  });

  describe('S3 branch (inactive by default)', () => {
    const original = process.env.S3_PUBLIC_URL_HOST;
    afterEach(() => {
      if (original === undefined) delete process.env.S3_PUBLIC_URL_HOST;
      else process.env.S3_PUBLIC_URL_HOST = original;
    });

    it('accepts nothing remote while S3_PUBLIC_URL_HOST is unset', () => {
      delete process.env.S3_PUBLIC_URL_HOST;
      expect(
        rejects(
          SendMessageDto,
          'attachmentUrl',
          `https://cdn.example.com/messages/${UUID}.jpg`,
        ),
      ).toBe(true);
    });

    it('accepts the configured host only, and only for the right folder and shape', () => {
      process.env.S3_PUBLIC_URL_HOST = 'cdn.example.com';
      const check = (url: string) =>
        accepts(SendMessageDto, 'attachmentUrl', url);

      expect(check(`https://cdn.example.com/messages/${UUID}.jpg`)).toBe(true);
      expect(check(`https://cdn.example.com/jinva/messages/${UUID}.png`)).toBe(
        true,
      );
      expect(check(`https://evil.example.com/messages/${UUID}.jpg`)).toBe(
        false,
      );
      expect(check(`https://cdn.example.com/documents/${UUID}.pdf`)).toBe(
        false,
      );
      expect(check(`https://cdn.example.com/messages/kyc.pdf`)).toBe(false);
      expect(
        check(`https://cdn.example.com/messages/${UUID}.jpg?x=../../secret`),
      ).toBe(false);
    });
  });
});
