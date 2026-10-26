import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { S3StorageProvider } from './providers/s3-storage.provider';
import {
  LEGACY_MEDIA_MAX_AGE_MS,
  LEGACY_MEDIA_PREFIX,
} from './legacy-media.config';
import {
  isSafeMediaFilename,
  PUBLIC_UPLOAD_FOLDERS,
  type PublicUploadFolder,
} from './upload-folders';

/**
 * Proxied delivery of public-folder media from the bucket
 * (`STORAGE_PUBLIC_DELIVERY=proxy`), so the bucket itself can stay private —
 * e.g. a Backblaze B2 bucket on a free account with no card on file.
 *
 * Mounted at `/uploads/<folder>/<file>` for every PUBLIC folder, *before* the
 * legacy static handler (`legacy-media.config.ts`): a hit streams from the
 * bucket, a miss falls through to local disk, where pre-cutover files live.
 * The URL shape is exactly what `LocalStorageProvider` has always stored, so
 * the frontend's `resolveMediaUrl` needs no change.
 *
 * Active whenever `STORAGE_PROVIDER=s3`, in BOTH delivery modes. That is what
 * makes moving to a public bucket a one-line switch: set
 * `STORAGE_PUBLIC_DELIVERY=direct`, and new uploads get bucket URLs while every
 * `/uploads/...` URL already stored keeps resolving through here.
 *
 * KYC folders are never mounted (allow-list, same rule as the legacy handler);
 * they stay behind the admin-only `GET /uploads/kyc/:folder/:filename`.
 * To restrict a folder later (e.g. `messages`, `job-attachments`), gate its
 * handler on the caller instead of serving it to everyone.
 */

export interface BucketMediaPlan {
  enabled: boolean;
  servedFolders: readonly PublicUploadFolder[];
  description: string;
}

type PublicMediaReader = Pick<S3StorageProvider, 'readPublic'>;

/** Only single, well-formed byte ranges are forwarded to the bucket. */
const RANGE_HEADER = /^bytes=\d*-\d*$/;

const CACHE_CONTROL = `public, max-age=${Math.floor(LEGACY_MEDIA_MAX_AGE_MS / 1000)}, immutable`;

export function resolveBucketMediaPlan(
  env: NodeJS.ProcessEnv = process.env,
): BucketMediaPlan {
  if ((env.STORAGE_PROVIDER ?? 'local') !== 's3') {
    return {
      enabled: false,
      servedFolders: [],
      description: `STORAGE_PROVIDER is not s3 — ${LEGACY_MEDIA_PREFIX}/* is not streamed from a bucket.`,
    };
  }
  const delivery = env.STORAGE_PUBLIC_DELIVERY?.trim() || 'direct';
  return {
    enabled: true,
    servedFolders: PUBLIC_UPLOAD_FOLDERS,
    description:
      `STORAGE_PROVIDER=s3, STORAGE_PUBLIC_DELIVERY=${delivery} — ` +
      `${LEGACY_MEDIA_PREFIX}/{${PUBLIC_UPLOAD_FOLDERS.join(',')}} is streamed from the bucket ` +
      (delivery === 'proxy'
        ? 'for every new upload'
        : 'for URLs stored while delivery was proxy; new uploads link to the bucket directly') +
      ', falling back to local disk for pre-cutover files.',
  };
}

export function createBucketMediaHandler(
  reader: PublicMediaReader,
  folder: PublicUploadFolder,
  logger: Pick<Logger, 'warn'> = new Logger('BucketMediaServing'),
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();

    // Mounted at `<prefix>/<folder>`, so `req.path` is `/<filename>`.
    const filename = req.path.slice(1);
    if (!isSafeMediaFilename(filename)) return next();

    const rangeHeader = req.headers.range;
    const range =
      typeof rangeHeader === 'string' && RANGE_HEADER.test(rangeHeader)
        ? rangeHeader
        : undefined;

    let object: Awaited<ReturnType<PublicMediaReader['readPublic']>>;
    try {
      object = await reader.readPublic(folder, filename, range);
    } catch {
      // The provider already logged the cause by error name only and threw a
      // sanitised 5xx; answer with nothing about the bucket either.
      logger.warn(`Bucket read failed for ${folder}/${filename}`);
      if (!res.headersSent) {
        res.status(503).json({
          status: 'error',
          message: 'File temporarily unavailable. Please try again later.',
        });
      }
      return;
    }

    // Not in the bucket: let the legacy local-disk handler try.
    if (!object) return next();

    res.status(object.contentRange ? 206 : 200);
    res.setHeader('Content-Type', object.contentType);
    if (object.contentLength !== undefined) {
      res.setHeader('Content-Length', String(object.contentLength));
    }
    if (object.contentRange)
      res.setHeader('Content-Range', object.contentRange);
    res.setHeader('Accept-Ranges', 'bytes');
    // UUID filenames make every public object immutable, as on local disk.
    res.setHeader('Cache-Control', CACHE_CONTROL);
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (req.method === 'HEAD') {
      object.stream.destroy();
      res.end();
      return;
    }

    object.stream.on('error', () => {
      logger.warn(`Bucket stream broke for ${folder}/${filename}`);
      res.destroy();
    });
    object.stream.pipe(res);
  };
}

export function applyBucketMediaServing(
  app: NestExpressApplication,
  env: NodeJS.ProcessEnv = process.env,
): BucketMediaPlan {
  const plan = resolveBucketMediaPlan(env);
  if (!plan.enabled) return plan;

  const provider = app.get(S3StorageProvider);
  for (const folder of plan.servedFolders) {
    app.use(
      `${LEGACY_MEDIA_PREFIX}/${folder}`,
      createBucketMediaHandler(provider, folder),
    );
  }
  return plan;
}
