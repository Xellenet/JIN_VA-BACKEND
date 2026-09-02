import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  PRIVATE_UPLOAD_FOLDERS,
  PUBLIC_UPLOAD_FOLDERS,
} from './upload-folders';

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
 * ── What is mounted, and what deliberately is not ───────────────────────────
 * The mount is an **allow-list of public folders**, not the whole `uploads`
 * tree. One static handler per folder in `PUBLIC_UPLOAD_FOLDERS`, each at
 * `/uploads/<folder>`.
 *
 * `documents` and `selfies` — identity documents and KYC selfies — are
 * therefore not reachable through this mount at all: `/uploads/documents/x.jpg`
 * matches no handler and falls through to Nest's clean JSON 404. That closes
 * two problems at once. First, the delivery leg of the S3 cutover: the admin
 * verification screen used to render those stored URLs as plain `<img>` tiles,
 * which meant the objects had to be anonymously readable for the feature to
 * work. Second, this mount's own cache policy: `immutable, maxAge` 365 days
 * emits `Cache-Control: public, max-age=31536000, immutable`, which for a
 * national-ID scan means any shared proxy, CDN or browser disk cache keeps it
 * for a year and keeps serving it even after the document is replaced or
 * revoked. Both folders now have exactly one reader:
 * `GET /uploads/kyc/:folder/:filename` — bearer token, `ADMIN` role,
 * `Cache-Control: private, no-store`.
 *
 * Public media keeps the long immutable caching unchanged: stored filenames
 * are UUIDs, so those objects genuinely are immutable forever.
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
  /**
   * The folders actually mounted, in mount order. An allow-list: the KYC
   * folders are absent by construction, not by a filter that could be
   * accidentally inverted.
   */
  servedFolders: readonly string[];
  /**
   * The folders deliberately withheld from this mount. Read back only through
   * the authenticated admin-only KYC endpoint.
   */
  withheldFolders: readonly string[];
  /** Ready-to-log, credential-free explanation of the active choice. */
  description: string;
}

/** Legacy filenames are UUIDs, so a stored object is immutable forever. */
export const LEGACY_MEDIA_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

export const LEGACY_MEDIA_PREFIX = '/uploads';

/**
 * Only these folders are ever mounted publicly. `documents`/`selfies` are
 * excluded — see the header comment and `./upload-folders`.
 */
export const LEGACY_MEDIA_SERVED_FOLDERS = PUBLIC_UPLOAD_FOLDERS;

/** Never mounted publicly, in any mode. */
export const LEGACY_MEDIA_WITHHELD_FOLDERS = PRIVATE_UPLOAD_FOLDERS;

export function resolveLegacyMediaPlan(
  env: NodeJS.ProcessEnv = process.env,
): LegacyMediaPlan {
  const directory = join(process.cwd(), 'uploads');
  const withheld = `${LEGACY_MEDIA_WITHHELD_FOLDERS.join('/, ')}/ are never mounted here — they are readable only via GET /uploads/kyc/:folder/:filename (admin only).`;
  const s3Active = (env.STORAGE_PROVIDER ?? 'local') === 's3';

  if (env.SERVE_LEGACY_UPLOADS === 'false') {
    return {
      prefix: LEGACY_MEDIA_PREFIX,
      directory,
      servedFolders: [],
      withheldFolders: LEGACY_MEDIA_WITHHELD_FOLDERS,
      mode: 'disabled',
      enabled: false,
      description:
        `SERVE_LEGACY_UPLOADS=false — ${LEGACY_MEDIA_PREFIX}/* is not served by this process. ` +
        `Any row still holding a relative ${LEGACY_MEDIA_PREFIX}/... URL will 404.`,
    };
  }

  const base = {
    prefix: LEGACY_MEDIA_PREFIX,
    directory,
    servedFolders: LEGACY_MEDIA_SERVED_FOLDERS,
    withheldFolders: LEGACY_MEDIA_WITHHELD_FOLDERS,
    enabled: true as const,
  };

  if (s3Active) {
    return {
      ...base,
      mode: 'legacy-only',
      description:
        `STORAGE_PROVIDER=s3 — new media is written to the bucket and served from ` +
        `AWS_S3_PUBLIC_URL_BASE, never by this process. ${LEGACY_MEDIA_PREFIX}/{${LEGACY_MEDIA_SERVED_FOLDERS.join(',')}} ` +
        `is mounted read-only for pre-cutover rows only; set SERVE_LEGACY_UPLOADS=false once they are gone. ` +
        withheld,
    };
  }

  return {
    ...base,
    mode: 'active-store',
    description:
      `STORAGE_PROVIDER=local — this process is the media store and serves ` +
      `${LEGACY_MEDIA_PREFIX}/{${LEGACY_MEDIA_SERVED_FOLDERS.join(',')}}. ` +
      `PRD §9 wants media on a CDN: set STORAGE_PROVIDER=s3 (plus the AWS_S3_* variables) to get there. ` +
      withheld,
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

  // One handler per public folder, rather than one for the whole `uploads`
  // tree. The KYC folders are excluded by *not being in this list* — an
  // allow-list rather than a filter, so there is no predicate to get backwards
  // and no way for a folder added later to be public by default.
  for (const folder of plan.servedFolders) {
    app.useStaticAssets(join(plan.directory, folder), {
      prefix: `${plan.prefix}/${folder}`,
      // No directory listings and no implicit index.html for a tree of
      // user-uploaded files.
      index: false,
      redirect: false,
      // 'ignore' (404) rather than 'deny' (403). Note this is already `send`'s
      // own default (send@1.2.0 index.js:114-116), so it is stated for intent
      // rather than to change behaviour — and, checked against the installed
      // libraries, 'deny' would resolve to the *same* clean JSON 404 here, not
      // to a stack trace: `fallthrough` is unset and so defaults to `true`
      // (serve-static@2.2.0 index.js:50), `forwardError` starts `false` and is
      // only flipped by the `file` event, and `send`'s dotfile check runs in
      // `pipe()` before that event fires — so a 403 has `statusCode < 500`
      // with `forwardError === false` and serve-static takes the plain
      // `next()` branch, landing on Nest's AllExceptionsFilter.
      //
      // 'ignore' is still the right value, for two reasons that have nothing
      // to do with stack traces: a 404 discloses strictly less than a 403
      // (which would confirm the path exists), and it is the value that stays
      // correct if someone later adds `fallthrough: false` — under which a
      // 'deny' 403 *would* be forwarded to Express's `finalhandler`. The
      // HTML-stack-trace exposure that concern comes from is real, but it is
      // reachable only for 5xx-class `send` errors (`!(err.statusCode < 500)`
      // → `next(err)`), which no dotfile request produces.
      //
      // Stored filenames are UUIDs, so no legitimate upload is ever a dotfile.
      dotfiles: 'ignore',
      // Safe for every folder mounted here and only for those: UUID filenames
      // mean a public object is immutable forever. The KYC folders, where
      // year-long shared caching of an identity document would be a real
      // problem, are not mounted at all — their reader sends
      // `Cache-Control: private, no-store` instead.
      immutable: true,
      maxAge: LEGACY_MEDIA_MAX_AGE_MS,
      setHeaders: (res: ServerResponse) => {
        // The stored extension is already derived from sniffed bytes rather
        // than the client-supplied filename (see `LocalStorageProvider`);
        // nosniff stops a browser second-guessing that Content-Type anyway.
        res.setHeader('X-Content-Type-Options', 'nosniff');
      },
    });
  }

  return plan;
}
