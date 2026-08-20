import { S3StorageProvider } from './s3-storage.provider';

/**
 * QA verification spec for PF2a — exercises S3StorageProvider's upload/delete
 * logic against a mocked @aws-sdk/client-s3 client (a local test double), per
 * the QA charter: verify the S3 provider's code paths WITHOUT ever setting
 * STORAGE_PROVIDER=s3 in any real environment. This spec never touches
 * StorageProviderFactory or process.env.STORAGE_PROVIDER — it only exercises
 * S3StorageProvider's own upload()/delete() methods directly, in an isolated
 * jest process, restoring env vars afterwards.
 *
 * Written by QA (test code only) — no feature/provider code was modified to
 * produce this coverage.
 */

const sendMock = jest.fn();

jest.mock('@aws-sdk/client-s3', () => {
  return {
    S3Client: jest.fn().mockImplementation(() => ({ send: sendMock })),
    PutObjectCommand: jest
      .fn()
      .mockImplementation((input) => ({ __type: 'Put', input })),
    DeleteObjectCommand: jest
      .fn()
      .mockImplementation((input) => ({ __type: 'Delete', input })),
  };
});

describe('S3StorageProvider (QA — mocked S3 client, PF2a)', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    sendMock.mockReset();
    process.env.AWS_S3_BUCKET = 'jinva-portfolio-test';
    process.env.AWS_S3_REGION = 'eu-west-1';
    delete process.env.AWS_S3_ACCESS_KEY_ID;
    delete process.env.AWS_S3_SECRET_ACCESS_KEY;
    delete process.env.AWS_S3_PUBLIC_URL_BASE;
  });

  afterAll(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('uploads a buffer, uses the bucket/region from env, and returns the virtual-hosted-style URL when no CDN base is set', async () => {
    sendMock.mockResolvedValueOnce({});
    const provider = new S3StorageProvider();

    const result = await provider.upload(Buffer.from('fake-image-bytes'), {
      folder: 'portfolio',
      originalName: 'photo.jpg',
      mimetype: 'image/jpeg',
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
    const sentCommand = sendMock.mock.calls[0][0];
    expect(sentCommand.__type).toBe('Put');
    expect(sentCommand.input.Bucket).toBe('jinva-portfolio-test');
    expect(sentCommand.input.Key).toMatch(/^portfolio\/[a-f0-9-]+\.jpg$/);
    expect(sentCommand.input.ContentType).toBe('image/jpeg');
    expect(result.folder).toBe('portfolio');
    expect(result.url).toBe(
      `https://jinva-portfolio-test.s3.eu-west-1.amazonaws.com/${sentCommand.input.Key}`,
    );
  });

  it('uses AWS_S3_PUBLIC_URL_BASE (e.g. a CDN domain) when configured, instead of the raw S3 URL', async () => {
    process.env.AWS_S3_PUBLIC_URL_BASE = 'https://cdn.jinva.example/';
    sendMock.mockResolvedValueOnce({});
    const provider = new S3StorageProvider();

    const result = await provider.upload(Buffer.from('bytes'), {
      folder: 'avatars',
      originalName: 'me.png',
      mimetype: 'image/png',
    });

    expect(result.url.startsWith('https://cdn.jinva.example/avatars/')).toBe(
      true,
    );
  });

  it('falls back to the default AWS credential chain when access key / secret are unset (no crash, credentials undefined)', async () => {
    sendMock.mockResolvedValueOnce({});
    const provider = new S3StorageProvider();
    await provider.upload(Buffer.from('bytes'), {
      folder: 'documents',
      originalName: 'doc',
      mimetype: 'application/pdf',
    });
    // Reaching here without the S3Client constructor throwing confirms the
    // provider tolerates missing static credentials (falls back to the SDK's
    // default credential chain) rather than requiring them.
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('throws a clear error if AWS_S3_BUCKET is not configured (fails cleanly, no partial upload)', async () => {
    delete process.env.AWS_S3_BUCKET;
    const provider = new S3StorageProvider();

    await expect(
      provider.upload(Buffer.from('bytes'), {
        folder: 'portfolio',
        originalName: 'x.jpg',
        mimetype: 'image/jpeg',
      }),
    ).rejects.toThrow(/AWS_S3_BUCKET is not configured/);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('deletes an object by folder/filename using the same bucket configuration', async () => {
    sendMock.mockResolvedValueOnce({});
    const provider = new S3StorageProvider();

    await provider.delete(
      '11fc2f6a-517a-4354-bb3e-1a023cdd2940.jpg',
      'portfolio',
    );

    expect(sendMock).toHaveBeenCalledTimes(1);
    const sentCommand = sendMock.mock.calls[0][0];
    expect(sentCommand.__type).toBe('Delete');
    expect(sentCommand.input).toEqual({
      Bucket: 'jinva-portfolio-test',
      Key: 'portfolio/11fc2f6a-517a-4354-bb3e-1a023cdd2940.jpg',
    });
  });

  it('swallows delete errors (e.g. object already gone) instead of throwing, mirroring LocalStorageProvider', async () => {
    sendMock.mockRejectedValueOnce(new Error('NoSuchKey'));
    const provider = new S3StorageProvider();

    await expect(
      provider.delete('missing.jpg', 'portfolio'),
    ).resolves.toBeUndefined();
  });
});
