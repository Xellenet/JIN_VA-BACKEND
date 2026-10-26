import { PassThrough } from 'node:stream';
import type { NextFunction, Request, Response } from 'express';
import {
  createBucketMediaHandler,
  resolveBucketMediaPlan,
} from './bucket-media-serving';
import { PRIVATE_UPLOAD_FOLDERS } from './upload-folders';

/**
 * Proxied public-media delivery from a private bucket. The handler is driven
 * with a stub reader and plain request/response doubles — no bucket, no
 * network.
 */

function makeRes() {
  const headers: Record<string, string> = {};
  const res = new PassThrough() as unknown as Response & {
    headers: Record<string, string>;
    statusCode: number;
    body?: unknown;
  };
  res.headers = headers;
  res.statusCode = 200;
  Object.assign(res, {
    headersSent: false,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
  });
  return res;
}

function makeReq(path: string, extra: Partial<Request> = {}): Request {
  return { method: 'GET', path, headers: {}, ...extra } as Request;
}

const quietLogger = { warn: jest.fn() };

describe('resolveBucketMediaPlan', () => {
  it('is off unless STORAGE_PROVIDER=s3', () => {
    expect(resolveBucketMediaPlan({}).enabled).toBe(false);
    expect(resolveBucketMediaPlan({ STORAGE_PROVIDER: 'local' }).enabled).toBe(
      false,
    );
  });

  it('stays on in direct mode, so URLs stored while proxied keep working', () => {
    const plan = resolveBucketMediaPlan({
      STORAGE_PROVIDER: 's3',
      STORAGE_PUBLIC_DELIVERY: 'direct',
    });
    expect(plan.enabled).toBe(true);
  });

  it('never mounts a KYC folder', () => {
    const plan = resolveBucketMediaPlan({
      STORAGE_PROVIDER: 's3',
      STORAGE_PUBLIC_DELIVERY: 'proxy',
    });
    for (const folder of PRIVATE_UPLOAD_FOLDERS) {
      expect(plan.servedFolders as readonly string[]).not.toContain(folder);
    }
  });
});

describe('createBucketMediaHandler', () => {
  it('streams a hit with immutable caching and nosniff', async () => {
    const stream = new PassThrough();
    const reader = {
      readPublic: jest.fn().mockResolvedValue({
        stream,
        contentType: 'image/jpeg',
        contentLength: 3,
      }),
    };
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await createBucketMediaHandler(reader, 'avatars', quietLogger)(
      makeReq('/a1b2.jpg'),
      res,
      next,
    );

    expect(reader.readPublic).toHaveBeenCalledWith(
      'avatars',
      'a1b2.jpg',
      undefined,
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['cache-control']).toContain('immutable');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(next).not.toHaveBeenCalled();
  });

  it('falls through to local disk when the bucket has no such object', async () => {
    const reader = { readPublic: jest.fn().mockResolvedValue(null) };
    const next = jest.fn() as NextFunction;

    await createBucketMediaHandler(reader, 'avatars', quietLogger)(
      makeReq('/old.jpg'),
      makeRes(),
      next,
    );

    expect(next).toHaveBeenCalledWith();
  });

  it('never asks the bucket for an unsafe filename', async () => {
    const reader = { readPublic: jest.fn() };
    const next = jest.fn() as NextFunction;

    await createBucketMediaHandler(reader, 'avatars', quietLogger)(
      makeReq('/../private/documents/x.pdf'),
      makeRes(),
      next,
    );

    expect(reader.readPublic).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('answers 206 for a honoured byte range and drops malformed ones', async () => {
    const reader = {
      readPublic: jest.fn().mockResolvedValue({
        stream: new PassThrough(),
        contentType: 'video/mp4',
        contentLength: 100,
        contentRange: 'bytes 0-99/5000',
      }),
    };
    const res = makeRes();
    const handler = createBucketMediaHandler(reader, 'portfolio', quietLogger);

    await handler(
      makeReq('/clip.mp4', { headers: { range: 'bytes=0-99' } }),
      res,
      jest.fn(),
    );
    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 0-99/5000');

    await handler(
      makeReq('/clip.mp4', { headers: { range: 'bytes=0-1,5-9' } }),
      makeRes(),
      jest.fn(),
    );
    expect(reader.readPublic).toHaveBeenLastCalledWith(
      'portfolio',
      'clip.mp4',
      undefined,
    );
  });

  it('returns a generic 503 when the bucket fails, revealing nothing about it', async () => {
    const reader = {
      readPublic: jest.fn().mockRejectedValue(new Error('AccessDenied: key')),
    };
    const res = makeRes();

    await createBucketMediaHandler(reader, 'avatars', quietLogger)(
      makeReq('/a.jpg'),
      res,
      jest.fn(),
    );

    expect(res.statusCode).toBe(503);
    expect(JSON.stringify(res.body)).not.toMatch(/AccessDenied|key|bucket/i);
  });

  it('ignores anything but GET and HEAD', async () => {
    const reader = { readPublic: jest.fn() };
    const next = jest.fn() as NextFunction;

    await createBucketMediaHandler(reader, 'avatars', quietLogger)(
      makeReq('/a.jpg', { method: 'POST' }),
      makeRes(),
      next,
    );

    expect(reader.readPublic).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });
});
