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
  __type: 'Put' | 'Delete' | 'Get';
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
  GetObjectCommand: jest
    .fn()
    .mockImplementation((input: Record<string, unknown>) => ({
      __type: 'Get',
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
    delete process.env.AWS_S3_ENDPOINT;
    delete process.env.AWS_S3_PRIVATE_BUCKET;
    delete process.env.STORAGE_PUBLIC_DELIVERY;
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
          'The AWS Access Key Id leak-sentinel-not-a-key you provided does not exist in our records.',
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
      expect(message).not.toMatch(/leak-sentinel/);
      expect(message).not.toMatch(/InvalidAccessKeyId/);
      expect(message).not.toMatch(/jinva-media-test/);
      expect(message).not.toMatch(/eu-west-1/);
    });

    it('logs the AWS error name and status, and never the AWS error message or stack', async () => {
      const awsError = Object.assign(
        new Error('Secret-bearing AWS detail leak-sentinel-not-a-key'),
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
      expect(logged[0]).not.toContain('leak-sentinel');
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

  describe('KYC key separation — the cutover must not publish identity documents', () => {
    const KYC_UPLOADS = [
      {
        folder: 'documents',
        originalName: 'ghana-card-front.pdf',
        mimetype: 'application/pdf',
      },
      {
        folder: 'selfies',
        originalName: 'selfie.jpg',
        mimetype: 'image/jpeg',
      },
    ] as const;

    for (const options of KYC_UPLOADS) {
      it(`writes ${options.folder} under the private/ prefix, not the public one`, async () => {
        sendMock.mockResolvedValueOnce({});
        const provider = new S3StorageProvider();

        const result = await provider.upload(Buffer.from('bytes'), options);

        const key = String(sendMock.mock.calls[0][0].input.Key);
        expect(key.startsWith(`private/${options.folder}/`)).toBe(true);
        expect(key).toContain(result.filename);
      });

      it(`never mints a public URL for ${options.folder}, even with a CDN base configured`, async () => {
        process.env.AWS_S3_PUBLIC_URL_BASE = 'https://cdn.jinva.example';
        sendMock.mockResolvedValueOnce({});
        const provider = new S3StorageProvider();

        const result = await provider.upload(Buffer.from('bytes'), options);

        // A stored public URL is what turns a later bucket-policy mistake into
        // a breach, so none may exist even while the bucket is private.
        expect(result.url).toBe(
          `/uploads/${options.folder}/${result.filename}`,
        );
        expect(result.url).not.toContain('cdn.jinva.example');
        expect(result.url).not.toContain('amazonaws.com');
        expect(result.url).not.toContain('jinva-media-test');
        expect(result.url).not.toMatch(/^https?:/);
      });
    }

    it('leaves every public folder on the public CDN prefix, exactly as before', async () => {
      process.env.AWS_S3_PUBLIC_URL_BASE = 'https://cdn.jinva.example';
      const provider = new S3StorageProvider();

      for (const folder of ['avatars', 'portfolio', 'reviews'] as const) {
        sendMock.mockResolvedValueOnce({});
        const result = await provider.upload(Buffer.from('bytes'), {
          folder,
          originalName: 'x.jpg',
          mimetype: 'image/jpeg',
        });

        expect(result.url).toBe(
          `https://cdn.jinva.example/${folder}/${result.filename}`,
        );
      }
    });

    it('keeps message and job photos off the public prefix too (QA MSG-18)', async () => {
      process.env.AWS_S3_PUBLIC_URL_BASE = 'https://cdn.jinva.example';
      const provider = new S3StorageProvider();

      for (const folder of ['messages', 'job-attachments'] as const) {
        sendMock.mockResolvedValueOnce({});
        const result = await provider.upload(Buffer.from('bytes'), {
          folder,
          originalName: 'x.jpg',
          mimetype: 'image/jpeg',
        });

        expect(result.url).toBe(`/uploads/${folder}/${result.filename}`);
        expect(result.url).not.toContain('cdn.jinva.example');
      }
    });

    it('deletes a KYC object from the private prefix, so cleanup targets the real key', async () => {
      sendMock.mockResolvedValueOnce({});
      const provider = new S3StorageProvider();

      await provider.delete('abc.jpg', 'selfies');

      expect(sendMock.mock.calls[0][0].input).toEqual({
        Bucket: 'jinva-media-test',
        Key: 'private/selfies/abc.jpg',
      });
    });

    describe('readPrivate()', () => {
      it('reads from the private prefix and reports the stored content type', async () => {
        sendMock.mockResolvedValueOnce({
          Body: 'stream-stand-in',
          ContentType: 'application/pdf',
          ContentLength: 1234,
        });
        const provider = new S3StorageProvider();

        const object = await provider.readPrivate('documents', 'abc.pdf');

        expect(sendMock.mock.calls[0][0].__type).toBe('Get');
        expect(sendMock.mock.calls[0][0].input).toEqual({
          Bucket: 'jinva-media-test',
          Key: 'private/documents/abc.pdf',
        });
        expect(object?.contentType).toBe('application/pdf');
        expect(object?.contentLength).toBe(1234);
      });

      it('returns null for a missing key, so the caller can fall back to legacy local disk', async () => {
        sendMock.mockRejectedValueOnce(
          Object.assign(new Error('nope'), {
            name: 'NoSuchKey',
            $metadata: { httpStatusCode: 404 },
          }),
        );
        const provider = new S3StorageProvider();

        await expect(
          provider.readPrivate('documents', 'abc.pdf'),
        ).resolves.toBeNull();
      });

      it('still translates a real AWS failure into the generic 5xx, leaking nothing', async () => {
        sendMock.mockRejectedValueOnce(
          Object.assign(new Error('Denied for key leak-sentinel-not-a-key'), {
            name: 'AccessDenied',
            $metadata: { httpStatusCode: 403 },
          }),
        );
        const provider = new S3StorageProvider();

        const thrown = await provider.readPrivate('documents', 'abc.pdf').then(
          () => null,
          (err: unknown) => err,
        );

        expect(thrown).toBeInstanceOf(InternalServerErrorException);
        expect((thrown as InternalServerErrorException).message).toBe(
          'File storage is temporarily unavailable. Please try again later.',
        );
      });
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
        Object.assign(new Error('leak-sentinel-not-a-key in the detail'), {
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
      expect(logged[0]).not.toContain('leak-sentinel');
      warnSpy.mockRestore();
    });
  });

  describe('STORAGE_PUBLIC_DELIVERY', () => {
    it('defaults to direct: public folders get the bucket URL, as before', async () => {
      sendMock.mockResolvedValueOnce({});

      const result = await new S3StorageProvider().upload(
        Buffer.from('b'),
        JPEG_UPLOAD,
      );

      expect(result.url).toBe(
        `https://jinva-media-test.s3.eu-west-1.amazonaws.com/avatars/${result.filename}`,
      );
    });

    it('proxy: public folders get the /uploads URL this process streams', async () => {
      process.env.STORAGE_PUBLIC_DELIVERY = 'proxy';
      sendMock.mockResolvedValueOnce({});

      const result = await new S3StorageProvider().upload(
        Buffer.from('b'),
        JPEG_UPLOAD,
      );

      expect(result.url).toBe(`/uploads/avatars/${result.filename}`);
    });

    it('proxy: KYC folders still get the non-fetchable private reference', async () => {
      process.env.STORAGE_PUBLIC_DELIVERY = 'proxy';
      sendMock.mockResolvedValueOnce({});

      const result = await new S3StorageProvider().upload(Buffer.from('b'), {
        folder: 'selfies',
        originalName: 's.jpg',
        mimetype: 'image/jpeg',
      });

      // Same reference shape as before; it is not fetchable because no handler
      // mounts a KYC folder (see bucket-media-serving.spec.ts), and the object
      // itself lives under the private/ key prefix.
      expect(result.url).toBe(`/uploads/selfies/${result.filename}`);
      expect(String(sendMock.mock.calls[0][0].input.Key)).toBe(
        `private/selfies/${result.filename}`,
      );
    });

    it('reports an unknown delivery value instead of guessing', () => {
      process.env.STORAGE_PUBLIC_DELIVERY = 'public';
      expect(new S3StorageProvider().missingConfiguration()).toEqual([
        'STORAGE_PUBLIC_DELIVERY',
      ]);
    });

    it('readPublic forwards a byte range and reports the honoured range', async () => {
      sendMock.mockResolvedValueOnce({
        Body: {},
        ContentType: 'video/mp4',
        ContentLength: 100,
        ContentRange: 'bytes 0-99/5000',
      });

      const object = await new S3StorageProvider().readPublic(
        'portfolio',
        'clip.mp4',
        'bytes=0-99',
      );

      expect(sendMock.mock.calls[0][0].input).toEqual(
        expect.objectContaining({
          Key: 'portfolio/clip.mp4',
          Range: 'bytes=0-99',
        }),
      );
      expect(object?.contentRange).toBe('bytes 0-99/5000');
    });
  });

  describe('S3-compatible endpoint (e.g. Backblaze B2)', () => {
    const KYC_PDF = {
      folder: 'documents',
      originalName: 'id.pdf',
      mimetype: 'application/pdf',
    } as const;

    beforeEach(() => {
      process.env.AWS_S3_ENDPOINT =
        'https://s3.eu-central-003.backblazeb2.com/';
      process.env.AWS_S3_REGION = 'eu-central-003';
      process.env.AWS_S3_PRIVATE_BUCKET = 'jinva-kyc-test';
    });

    it('refuses to run without a private bucket, since B2 visibility is per bucket', () => {
      delete process.env.AWS_S3_PRIVATE_BUCKET;
      expect(new S3StorageProvider().missingConfiguration()).toEqual([
        'AWS_S3_PRIVATE_BUCKET',
      ]);
    });

    it('configures the client for the endpoint with path-style addressing', async () => {
      const { S3Client } = jest.requireMock<{ S3Client: jest.Mock }>(
        '@aws-sdk/client-s3',
      );
      S3Client.mockClear();
      sendMock.mockResolvedValueOnce({});

      await new S3StorageProvider().upload(Buffer.from('b'), JPEG_UPLOAD);

      expect(S3Client).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: 'https://s3.eu-central-003.backblazeb2.com',
          forcePathStyle: true,
          requestChecksumCalculation: 'WHEN_REQUIRED',
        }),
      );
    });

    it('builds public URLs on the endpoint, path-style', async () => {
      sendMock.mockResolvedValueOnce({});

      const result = await new S3StorageProvider().upload(
        Buffer.from('b'),
        JPEG_UPLOAD,
      );

      expect(result.url).toBe(
        `https://s3.eu-central-003.backblazeb2.com/jinva-media-test/avatars/${result.filename}`,
      );
    });

    it('allows ONE private bucket for everything when delivery is proxy', () => {
      process.env.STORAGE_PUBLIC_DELIVERY = 'proxy';
      process.env.AWS_S3_PRIVATE_BUCKET = 'jinva-media-test';
      expect(new S3StorageProvider().missingConfiguration()).toEqual([]);
    });

    it('refuses one shared bucket when delivery is direct, since that bucket is public', () => {
      process.env.AWS_S3_PRIVATE_BUCKET = 'jinva-media-test';
      expect(new S3StorageProvider().missingConfiguration()).toEqual([
        'AWS_S3_PRIVATE_BUCKET',
      ]);
    });

    it('writes public folders to the main bucket', async () => {
      sendMock.mockResolvedValueOnce({});

      await new S3StorageProvider().upload(Buffer.from('b'), JPEG_UPLOAD);

      expect(sendMock.mock.calls[0][0].input.Bucket).toBe('jinva-media-test');
    });

    it('writes, reads and deletes KYC objects only in the private bucket', async () => {
      sendMock.mockResolvedValue({ Body: {}, ContentType: 'application/pdf' });
      const provider = new S3StorageProvider();

      const { filename } = await provider.upload(Buffer.from('b'), KYC_PDF);
      await provider.readPrivate('documents', filename);
      await provider.delete(filename, 'documents');

      const buckets = sendMock.mock.calls.map((c) => c[0].input.Bucket);
      expect(buckets).toEqual([
        'jinva-kyc-test',
        'jinva-kyc-test',
        'jinva-kyc-test',
      ]);
    });
  });
});
