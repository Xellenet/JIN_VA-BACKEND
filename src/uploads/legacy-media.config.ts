import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import type { NestExpressApplication } from '@nestjs/platform-express';

/**
 * BI2 — how uploaded media is served, and the reasoning behind the choice.
 *
 * PRD §9 requires media to be served from a CDN and "never proxied through the
 * app server". Before this change `main.ts` mounted
 * `useStaticAssets(join(process.cwd(), 'uploads'), { prefix: '/uploads' })`
 * unconditionally, so the NestJS process was the media CDN in every
 * environment.
 *
 * ── The decision ────────────────────────────────────────────────────────────
 * The requirements doc offers two ways to keep historical media working after
 * the S3 cutover (BI2 / "Edge cases → Backend infra"):
 *
 *   (a) keep the static handler for legacy paths only, or
 *   (b) migrate the stored URLs.
 *
 * **We chose (a).** (b) does not fit this schema, for a reason that has nothing
 * to do with SQL being awkward: the legacy files physically live on the app
 * server's disk under `uploads/`, and *not* in the bucket. A TypeORM migration
 * can rewrite a `/uploads/portfolio/x.jpg` column value to
 * `https://cdn.example/portfolio/x.jpg`, but it cannot copy the bytes — so
 * every rewritten row would point at an object that does not exist and 404.
 * That is precisely the blocker the requirements doc calls out ("broken
 * historical avatars, portfolio items or verification documents are a
 * blocker"), and it would be irreversible in the sense that matters: the
 * original relative URL is gone from the row.
 *
 * The stored URLs are also spread across eight columns in six tables rather
 * than one place, and not all of them are plain scalars:
 * `users.profile_picture`, `portfolio_items.file_url`,
 * `artisan_verifications.document_front_url` / `.document_back_url` /
 * `.selfie_url`, `review_photos.url`, `messages.attachment_url`, and
 * `bookings.attachment_urls` — which is `jsonb` holding an *array* of URLs, so
 * rewriting it means a JSON-element-wise update rather than a prefix replace.
 * Each would need its own irreversible pass, all for no benefit while the
 * bytes stay on local disk.
 *
 * Option (a) needs no schema change at all, because the two URL shapes are
 * already self-distinguishing: `LocalStorageProvider` returns a **relative**
 * `/uploads/<folder>/<file>`, `S3StorageProvider` returns an **absolute**
 * `https://…` URL. Once `STORAGE_PROVIDER=s3`, nothing new can ever be written
 * under `/uploads`, so that prefix becomes a closed, read-only legacy set that
 * only shrinks — which is exactly "the static handler scoped to legacy paths
 * only". No row is touched, so nothing can break.
 *
 * ── The end state ───────────────────────────────────────────────────────────
 * Serving the frozen legacy set is still the app process serving media, so an
 * operator who has copied the old `uploads/` tree into the bucket (or who has
 * confirmed no row holds a relative URL any more) can set
 * `SERVE_LEGACY_UPLOADS=false` and reach BI2's literal "no media request is
 * served by the NestJS process". It defaults to **on** so that flipping
 * `STORAGE_PROVIDER` alone can never break existing media.
 *
 * Environment variables read here — **names only, values are never inspected,
 * logged or committed**:
 * - `STORAGE_PROVIDER`       (`local` default / `s3`) — the same variable
 *                             `StorageProviderFactory` selects on.
 * - `SERVE_LEGACY_UPLOADS`   (optional) — set to the exact string `false` to
 *                             stop serving the legacy `/uploads` tree.
 */

export type LegacyMediaMode =
  /** Local disk is the active store: this handler serves *all* media. */
  | 'active-store'
  /** S3 is active: this handler serves only pre-cutover media. */
  | 'legacy-only'
  /** Nothing is served from the app process. */
  | 'disabled';

export interface LegacyMediaPlan {
  mode: LegacyMediaMode;
  /** Whether `main.ts` should mount the static handler at all. */
  enabled: boolean;
  /** URL prefix historical rows were written with. Not configurable. */
  prefix: string;
  /** Absolute path of the on-disk tree those rows point into. */
  directory: string;
  /** Ready-to-log, credential-free explanation of the active choice. */
  description: string;
}

/** Legacy filenames are UUIDs, so a stored object is immutable forever. */
export const LEGACY_MEDIA_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

export const LEGACY_MEDIA_PREFIX = '/uploads';

export function resolveLegacyMediaPlan(
  env: NodeJS.ProcessEnv = process.env,
): LegacyMediaPlan {
  const directory = join(process.cwd(), 'uploads');
  const base = { prefix: LEGACY_MEDIA_PREFIX, directory };
  const s3Active = (env.STORAGE_PROVIDER ?? 'local') === 's3';

  if (env.SERVE_LEGACY_UPLOADS === 'false') {
    return {
      ...base,
      mode: 'disabled',
      enabled: false,
      description:
        `SERVE_LEGACY_UPLOADS=false — ${LEGACY_MEDIA_PREFIX}/* is not served by this process. ` +
        `Any row still holding a relative ${LEGACY_MEDIA_PREFIX}/... URL will 404.`,
    };
  }

  if (s3Active) {
    return {
      ...base,
      mode: 'legacy-only',
      enabled: true,
      description:
        `STORAGE_PROVIDER=s3 — new media is written to the bucket and served from ` +
        `AWS_S3_PUBLIC_URL_BASE, never by this process. ${LEGACY_MEDIA_PREFIX}/* is mounted ` +
        `read-only for pre-cutover rows only; set SERVE_LEGACY_UPLOADS=false once they are gone.`,
    };
  }

  return {
    ...base,
    mode: 'active-store',
    enabled: true,
    description:
      `STORAGE_PROVIDER=local — this process is the media store and serves ${LEGACY_MEDIA_PREFIX}/*. ` +
      `PRD §9 wants media on a CDN: set STORAGE_PROVIDER=s3 (plus the AWS_S3_* variables) to get there.`,
  };
}

/**
 * Mounts (or deliberately does not mount) the legacy media handler and returns
 * the plan it acted on, so the caller can log it.
 *
 * Lives here rather than inline in `main.ts` so the e2e suite exercises the
 * *same* code the process runs — the BI2 blocker guard ("an old record's image
 * still loads") is worth nothing if the test asserts against a copy of the
 * configuration.
 */
export function applyLegacyMediaServing(
  app: NestExpressApplication,
  env: NodeJS.ProcessEnv = process.env,
): LegacyMediaPlan {
  const plan = resolveLegacyMediaPlan(env);
  if (!plan.enabled) return plan;

  app.useStaticAssets(plan.directory, {
    prefix: plan.prefix,
    // No directory listings and no implicit index.html for a tree of
    // user-uploaded files.
    index: false,
    redirect: false,
    // Deliberately 'ignore' (404) rather than 'deny' (403): serve-static
    // reports a 403 by calling `next(err)`, and Nest installs no Express
    // error handler in front of its router — so the error would reach
    // Express's default `finalhandler`, which renders an HTML stack trace
    // whenever NODE_ENV is not 'production'. 'ignore' keeps every miss on the
    // fall-through path, where Nest's AllExceptionsFilter answers with the
    // normal clean JSON 404. Stored filenames are UUIDs, so no legitimate
    // upload is ever a dotfile.
    dotfiles: 'ignore',
    immutable: true,
    maxAge: LEGACY_MEDIA_MAX_AGE_MS,
    setHeaders: (res: ServerResponse) => {
      // The stored extension is already derived from sniffed bytes rather than
      // the client-supplied filename (see `LocalStorageProvider`); nosniff
      // stops a browser second-guessing that Content-Type anyway.
      res.setHeader('X-Content-Type-Options', 'nosniff');
    },
  });

  return plan;
}
