import { join } from 'node:path';
import {
  LEGACY_MEDIA_MAX_AGE_MS,
  LEGACY_MEDIA_PREFIX,
  resolveLegacyMediaPlan,
} from './legacy-media.config';

/**
 * BI2: the media-serving decision. The property that matters most is the one
 * the requirements doc calls a blocker — flipping `STORAGE_PROVIDER` to `s3`
 * must never stop historical `/uploads/...` rows from resolving.
 *
 * `resolveLegacyMediaPlan` takes its environment as an argument precisely so
 * this can be verified without mutating any real process environment.
 */
describe('resolveLegacyMediaPlan (BI2)', () => {
  const uploadsDir = join(process.cwd(), 'uploads');

  it('serves everything from the app process when local disk is the store', () => {
    const plan = resolveLegacyMediaPlan({});

    expect(plan.mode).toBe('active-store');
    expect(plan.enabled).toBe(true);
    expect(plan.prefix).toBe(LEGACY_MEDIA_PREFIX);
    expect(plan.directory).toBe(uploadsDir);
  });

  it('treats an explicit STORAGE_PROVIDER=local the same as unset', () => {
    expect(resolveLegacyMediaPlan({ STORAGE_PROVIDER: 'local' }).mode).toBe(
      'active-store',
    );
  });

  it('KEEPS serving /uploads after the S3 cutover, so pre-cutover rows still resolve', () => {
    const plan = resolveLegacyMediaPlan({ STORAGE_PROVIDER: 's3' });

    // The blocker guard: enabling S3 alone must not break historical avatars,
    // portfolio items or verification documents.
    expect(plan.enabled).toBe(true);
    expect(plan.mode).toBe('legacy-only');
    expect(plan.prefix).toBe(LEGACY_MEDIA_PREFIX);
  });

  it('describes the S3 state as legacy-only and points at the way to switch it off', () => {
    const plan = resolveLegacyMediaPlan({ STORAGE_PROVIDER: 's3' });

    expect(plan.description).toContain('AWS_S3_PUBLIC_URL_BASE');
    expect(plan.description).toContain('SERVE_LEGACY_UPLOADS=false');
  });

  it('stops serving media from the app process when the operator opts out', () => {
    const plan = resolveLegacyMediaPlan({
      STORAGE_PROVIDER: 's3',
      SERVE_LEGACY_UPLOADS: 'false',
    });

    expect(plan.enabled).toBe(false);
    expect(plan.mode).toBe('disabled');
  });

  it('only accepts the exact string "false" as the opt-out, never a truthy-looking value', () => {
    for (const value of ['true', 'FALSE', '0', '', 'no']) {
      expect(
        resolveLegacyMediaPlan({ SERVE_LEGACY_UPLOADS: value }).enabled,
      ).toBe(true);
    }
  });

  it('never leaks a configuration value into the log line — only variable names and modes', () => {
    const plan = resolveLegacyMediaPlan({
      STORAGE_PROVIDER: 's3',
      AWS_S3_BUCKET: 'a-real-bucket-name',
      AWS_S3_PUBLIC_URL_BASE: 'https://cdn.real.example',
      AWS_S3_SECRET_ACCESS_KEY: 'super-secret-value',
    });

    expect(plan.description).not.toContain('a-real-bucket-name');
    expect(plan.description).not.toContain('https://cdn.real.example');
    expect(plan.description).not.toContain('super-secret-value');
  });

  it('caches legacy media for a year, since stored filenames are immutable UUIDs', () => {
    expect(LEGACY_MEDIA_MAX_AGE_MS).toBe(365 * 24 * 60 * 60 * 1000);
  });
});
