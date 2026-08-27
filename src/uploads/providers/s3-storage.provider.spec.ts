import { InternalServerErrorException } from '@nestjs/common';
import { S3StorageProvider } from './s3-storage.provider';

/**
 * BI1: the S3 cutover's failure discipline. Complements the QA-owned
 * `s3-storage.provider.qa.spec.ts` (which covers the happy paths) by pinning
 * the three rules the requirements doc calls out as blockers:
 *   - a storage misconfiguration never becomes a silent no-op success,
 *   - it surfaces as a clean 5xx, and
 *   - neither the client response nor the log line carries provider detail
 *     (stack traces, bucket ARNs, access-key identifiers).
 *
 * `STORAGE_PROVIDER` is never set here — this exercises the provider class
 * directly, exactly as the QA spec does.
 */

interface MockCommand {
  __type: 'Put' | 'Delete';
  input: Record<string, unknown>;
}

const sendMock = jest.fn<Promise<unknown>, [MockCommand]>();

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: sendMock })),
  PutObjectCommand: jest
    .fn()
    .mockImplementation((input: Record<string, unknown>) => ({
      __type: 'Put',
      input,
    })),
  DeleteObjectCommand: jest
    .fn()
    .mockImplementation((input: Record<string, unknown>) => ({
      __type: 'Delete',
      input,
    })),
}));

const JPEG_UPLOAD = {
  folder: 'avatars',
  originalName: 'me.jpg',
  mimetype: 'image/jpeg',
} as const;

describe('S3StorageProvider — BI1 failure discipline', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    sendMock.mockReset();
    process.env.AWS_S3_BUCKET = 'jinva-media-test';
    process.env.AWS_S3_REGION = 'eu-west-1';
    delete process.env.AWS_S3_ACCESS_KEY_ID;
    delete process.env.AWS_S3_SECRET_ACCESS_KEY;
    delete process.env.AWS_S3_PUBLIC_URL_BASE;
  });

  afterAll(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  describe('missingConfiguration()', () => {
    it('reports nothing when bucket and region are both set', () => {
      expect(new S3StorageProvider().missingConfiguration()).toEqual([]);
    });

    it('reports AWS_S3_REGION as required, so a wrong public URL can never be persisted', () => {
      delete process.env.AWS_S3_REGION;
      expect(new S3StorageProvider().missingConfiguration()).toEqual([
        'AWS_S3_REGION',
      ]);
    });

    it('reports every missing variable by name at once', () => {
      delete process.env.AWS_S3_BUCKET;
      delete process.env.AWS_S3_REGION;
      expect(new S3StorageProvider().missingConfiguration()).toEqual([
        'AWS_S3_BUCKET',
        'AWS_S3_REGION',
      ]);
    });

    it('treats a whitespace-only value as unset rather than as a usable bucket name', () => {
      process.env.AWS_S3_BUCKET = '   ';
      expect(new S3StorageProvider().missingConfiguration()).toEqual([
        'AWS_S3_BUCKET',
      ]);
    });
  });

  describe('upload() with configuration missing', () => {
    it('throws a 5xx naming the missing variable and never contacts S3 (no silent no-op success)', async () => {
      delete process.env.AWS_S3_REGION;
      const provider = new S3StorageProvider();

      await expect(
        provider.upload(Buffer.from('bytes'), JPEG_UPLOAD),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
      expect(sendMock).not.toHaveBeenCalled();
    });

    it('names the variable but never a value, and points at the STORAGE_PROVIDER cutover', async () => {
      delete process.env.AWS_S3_BUCKET;
      const provider = new S3StorageProvider();

      await expect(
        provider.upload(Buffer.from('bytes'), JPEG_UPLOAD),
      ).rejects.toThrow(
        /AWS_S3_BUCKET is not configured.*STORAGE_PROVIDER="s3"/,
      );
      // The bucket name that *was* configured must not appear in the error.
      await expect(
        provider.upload(Buffer.from('bytes'), JPEG_UPLOAD),
      ).rejects.not.toThrow(/jinva-media-test/);
    });
  });

  describe('upload() when S3 itself rejects the request', () => {
    it('translates an AWS failure into a generic 5xx that leaks no provider detail', async () => {
      const awsError = Object.assign(
        new Error(
          'The AWS Access Key Id AKIAEXAMPLESECRETLEAK you provided does not exist in our records.',
        ),
        {
          name: 'InvalidAccessKeyId',
          $metadata: { httpStatusCode: 403 },
        },
      );
      sendMock.mockRejectedValueOnce(awsError);
      const provider = new S3StorageProvider();

      const thrown = await provider
        .upload(Buffer.from('bytes'), JPEG_UPLOAD)
        .then(
          () => null,
          (err: unknown) => err,
        );

      expect(thrown).toBeInstanceOf(InternalServerErrorException);
      const message = (thrown as InternalServerErrorException).message;
      expect(message).toBe(
        'File storage is temporarily unavailable. Please try again later.',
      );
      // Nothing from the AWS payload — key material, error name, bucket — may
      // reach the client, in any NODE_ENV.
      expect(message).not.toMatch(/AKIA/);
      expect(message).not.toMatch(/InvalidAccessKeyId/);
      expect(message).not.toMatch(/jinva-media-test/);
      expect(message).not.toMatch(/eu-west-1/);
    });

    it('logs the AWS error name and status, and never the AWS error message or stack', async () => {
      const awsError = Object.assign(
        new Error('Secret-bearing AWS detail AKIAEXAMPLESECRETLEAK'),
        { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } },
      );
      sendMock.mockRejectedValueOnce(awsError);
      const provider = new S3StorageProvider();
      const logged: string[] = [];
      const errorSpy = jest
        .spyOn(
          (provider as unknown as { logger: { error: (m: string) => void } })
            .logger,
          'error',
        )
        .mockImplementation((m: string) => {
          logged.push(m);
        });

      await expect(
        provider.upload(Buffer.from('bytes'), JPEG_UPLOAD),
      ).rejects.toBeInstanceOf(InternalServerErrorException);

      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain('AccessDenied');
      expect(logged[0]).toContain('HTTP 403');
      expect(logged[0]).not.toContain('AKIA');
      expect(logged[0]).not.toContain('Secret-bearing AWS detail');
      errorSpy.mockRestore();
    });

    it('does not return an upload result when the put failed', async () => {
      sendMock.mockRejectedValueOnce(
        Object.assign(new Error('boom'), { name: 'NoSuchBucket' }),
      );
      const provider = new S3StorageProvider();

      const result = await provider
        .upload(Buffer.from('bytes'), JPEG_UPLOAD)
        .catch(() => 'threw' as const);

      expect(result).toBe('threw');
    });
  });

  describe('public URL construction', () => {
    it('never emits "undefined" in the host, because region is validated first', async () => {
      sendMock.mockResolvedValueOnce({});
      const provider = new S3StorageProvider();

      const result = await provider.upload(Buffer.from('bytes'), JPEG_UPLOAD);

      expect(result.url).not.toContain('undefined');
      expect(result.url).toBe(
        `https://jinva-media-test.s3.eu-west-1.amazonaws.com/avatars/${result.filename}`,
      );
    });

    it('trims trailing slashes off AWS_S3_PUBLIC_URL_BASE so the CDN URL has no double slash', async () => {
      process.env.AWS_S3_PUBLIC_URL_BASE = 'https://cdn.jinva.example///';
      sendMock.mockResolvedValueOnce({});
      const provider = new S3StorageProvider();

      const result = await provider.upload(Buffer.from('bytes'), JPEG_UPLOAD);

      expect(result.url).toBe(
        `https://cdn.jinva.example/avatars/${result.filename}`,
      );
    });
  });

  describe('delete()', () => {
    it('is a no-op (never a throw) when the provider is not configured', async () => {
      delete process.env.AWS_S3_BUCKET;
      const provider = new S3StorageProvider();

      await expect(
        provider.delete('abc.jpg', 'portfolio'),
      ).resolves.toBeUndefined();
      expect(sendMock).not.toHaveBeenCalled();
    });

    it('logs a failed delete by AWS error name only', async () => {
      sendMock.mockRejectedValueOnce(
        Object.assign(new Error('AKIAEXAMPLESECRETLEAK in the detail'), {
          name: 'NoSuchKey',
          $metadata: { httpStatusCode: 404 },
        }),
      );
      const provider = new S3StorageProvider();
      const logged: string[] = [];
      const warnSpy = jest
        .spyOn(
          (provider as unknown as { logger: { warn: (m: string) => void } })
            .logger,
          'warn',
        )
        .mockImplementation((m: string) => {
          logged.push(m);
        });

      await expect(
        provider.delete('abc.jpg', 'portfolio'),
      ).resolves.toBeUndefined();

      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain('NoSuchKey');
      expect(logged[0]).not.toContain('AKIA');
      warnSpy.mockRestore();
    });
  });
});
