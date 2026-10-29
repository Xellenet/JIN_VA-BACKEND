import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import {
  SUPPORTED_PHONE_COUNTRIES,
  type SupportedPhoneCountry,
} from '../common/constants/supported-phone-countries.constants';

/**
 * LOC10: the countries `GET /locations/suggestions` accepts. LOC10 requires
 * `country` to be in `SUPPORTED_PHONE_COUNTRIES`, so this is that shared list
 * (not a copy) and the two can never drift.
 */
export const LOCATION_SUPPORTED_COUNTRIES = SUPPORTED_PHONE_COUNTRIES;

export type LocationCountryCode = SupportedPhoneCountry;

/** LOC10: `q` is trimmed, then must be 2–100 characters. */
export const LOCATION_QUERY_MIN_LENGTH = 2;
export const LOCATION_QUERY_MAX_LENGTH = 100;

/** Default for `PHOTON_BASE_URL`. Only the proxy ever talks to it (LOC9). */
export const DEFAULT_PHOTON_BASE_URL = 'https://photon.komoot.io';

/**
 * LOC10: the fixed query parameters sent with every upstream call. PR1: these,
 * the normalised query text and the country code are the *only* things that
 * leave JinVa.
 */
export const PHOTON_LAYERS = ['city', 'district', 'locality'] as const;
export const PHOTON_RESULT_LIMIT = 8;
export const PHOTON_LANG = 'en';

/** LOC8: upstream timeout. */
export const PHOTON_TIMEOUT_MS = 1_500;

/** Upstream bodies are a few kB; refuse anything absurd. */
export const PHOTON_MAX_RESPONSE_BYTES = 512 * 1024;

/** LOC10: 24 h in-memory cache. */
export const SUGGESTION_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;

/**
 * LRU bound. Each entry is at most 8 short rows, so this is well under a
 * megabyte, and it keeps a stream of unique queries from growing memory
 * without limit.
 */
export const SUGGESTION_CACHE_MAX_ENTRIES = 2_000;

/**
 * R10: after an upstream failure, stop calling Photon for a short while and
 * answer `available: false` straight away. A dead or throttling upstream then
 * costs the user nothing (no 1.5 s wait per keystroke) and we stop adding load
 * to a fair-use server that is already telling us no.
 */
export const UPSTREAM_COOLDOWN_AFTER_ERROR_MS = 10_000;
export const UPSTREAM_COOLDOWN_AFTER_429_MS = 60_000;
/** Upper bound on an upstream `Retry-After` we are willing to honour. */
export const UPSTREAM_MAX_COOLDOWN_MS = 15 * 60_000;

/** LOC10: per-IP limit, overridable via `LOCATION_SUGGESTIONS_RATE_LIMIT_PER_MINUTE`. */
export const DEFAULT_LOCATION_SUGGESTIONS_RATE_LIMIT = 30;
export const LOCATION_SUGGESTIONS_THROTTLER_NAME = 'location-suggestions';
export const LOCATION_SUGGESTIONS_RATE_LIMIT_ERROR_CODE =
  'LOCATION_SUGGESTIONS_RATE_LIMITED';

/**
 * Finds this service's own `package.json` by walking up from this file, so it
 * works from `src/` under ts-node/jest and from `dist/src/` in production
 * without depending on the process working directory.
 */
function readOwnPackageVersion(): string | undefined {
  let dir = __dirname;
  for (let i = 0; i < 6; i += 1) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as {
          name?: unknown;
          version?: unknown;
        };
        if (pkg.name === 'jinva-backend' && typeof pkg.version === 'string') {
          return pkg.version;
        }
      } catch {
        // Unreadable or not JSON: keep walking up.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * PR2: the outbound `User-Agent` is the app name and version only — never a
 * person's name or email, and deliberately not configurable from the
 * environment so nobody can put one there.
 */
export const PHOTON_USER_AGENT = `JinVa/${readOwnPackageVersion() ?? '0.0.0'}`;
