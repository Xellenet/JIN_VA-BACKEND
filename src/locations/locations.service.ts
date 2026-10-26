import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import {
  DEFAULT_PHOTON_BASE_URL,
  PHOTON_LANG,
  PHOTON_LAYERS,
  PHOTON_MAX_RESPONSE_BYTES,
  PHOTON_RESULT_LIMIT,
  PHOTON_TIMEOUT_MS,
  PHOTON_USER_AGENT,
  SUGGESTION_CACHE_MAX_ENTRIES,
  SUGGESTION_CACHE_TTL_MS,
  UPSTREAM_COOLDOWN_AFTER_429_MS,
  UPSTREAM_COOLDOWN_AFTER_ERROR_MS,
  UPSTREAM_MAX_COOLDOWN_MS,
} from './locations.constants';
import type {
  LocationSuggestionDto,
  LocationSuggestionsResponseDto,
} from './dto/location-suggestions-response.dto';
import { TtlLruCache } from './utils/ttl-lru-cache';
import {
  collapseWhitespace,
  normaliseRegion,
} from './utils/region-normalise.util';
import type { ReverseLocationResponseDto } from './dto/reverse-location.dto';

/** The subset of a Photon GeoJSON feature's `properties` we read. */
interface PhotonProperties {
  name?: unknown;
  osm_key?: unknown;
  osm_value?: unknown;
  city?: unknown;
  state?: unknown;
  countrycode?: unknown;
}

/**
 * R17: which OSM tags count as a *place* someone could live or work in. The
 * `locality` layer also returns facilities ("… Power Plant", "… Flour Mill"),
 * which carry tags like `power=plant` or `man_made=works`; anything not on this
 * allow-list is dropped.
 */
const PLACE_VALUES = new Set([
  'city',
  'town',
  'village',
  'hamlet',
  'suburb',
  'quarter',
  'neighbourhood',
  'borough',
  'locality',
  'municipality',
  'city_block',
  'isolated_dwelling',
]);

function isPlaceFeature(props: PhotonProperties): boolean {
  const key = props.osm_key;
  const value = props.osm_value;
  if (typeof key !== 'string' || typeof value !== 'string') return false;
  if (key === 'place') return PLACE_VALUES.has(value);
  if (key === 'boundary') return value === 'administrative';
  // Named residential areas ("East Legon Residential Area", row 25).
  if (key === 'landuse') return value === 'residential';
  return false;
}

/**
 * The parts of an axios error we read, checked structurally so this module
 * doesn't import `axios` directly (it's only a transitive dependency via
 * `@nestjs/axios`).
 */
interface HttpErrorLike {
  isAxiosError: true;
  code?: string;
  response?: { status?: number; headers?: Record<string, unknown> };
}

function isHttpError(error: unknown): error is HttpErrorLike {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { isAxiosError?: unknown }).isAxiosError === true
  );
}

/** Thrown internally when the upstream body isn't the GeoJSON we expect. */
class UpstreamPayloadError extends Error {
  constructor() {
    super('Unexpected upstream payload');
    this.name = 'UpstreamPayloadError';
  }
}

/**
 * LOC3/LOC8/LOC10, PR1/PR2/PR4/PR5: town-or-area suggestions, proxied to
 * Photon so the browser never talks to it.
 *
 * Privacy, by construction:
 * - `suggest()` takes only the query text and the country code, so there is
 *   nothing else it *could* forward — no request, headers, IP or cookie reach
 *   this class.
 * - The outbound request carries only `q`, `countrycode` and fixed params, with
 *   a generic `JinVa/<version>` User-Agent.
 * - Nothing here logs the query, the URL (which contains the query) or an axios
 *   error object (whose `config` contains the URL). Failure logs carry only the
 *   upstream status / error code.
 */
@Injectable()
export class LocationsService {
  private readonly logger = new Logger(LocationsService.name);
  private readonly endpoint: string;
  private readonly cache = new TtlLruCache<LocationSuggestionDto[]>(
    SUGGESTION_CACHE_MAX_ENTRIES,
    SUGGESTION_CACHE_TTL_MS,
  );
  /** Concurrent identical lookups share one upstream call. */
  private readonly inFlight = new Map<
    string,
    Promise<LocationSuggestionDto[] | null>
  >();
  private upstreamUnavailableUntil = 0;

  constructor(
    private readonly http: HttpService,
    config: ConfigService,
  ) {
    this.endpoint = LocationsService.resolveEndpoint(
      config.get<string>('PHOTON_BASE_URL'),
      this.logger,
    );
  }

  /** `<base>/api/`, falling back to the public server on a missing/bad value. */
  static resolveEndpoint(raw: string | undefined, logger?: Logger): string {
    const candidate = raw?.trim() || DEFAULT_PHOTON_BASE_URL;
    try {
      const url = new URL(candidate);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('unsupported protocol');
      }
      url.search = '';
      url.hash = '';
      url.pathname = `${url.pathname.replace(/\/+$/, '')}/api/`;
      return url.toString();
    } catch {
      logger?.warn(
        'PHOTON_BASE_URL is not a valid http(s) URL; using the default.',
      );
      return `${DEFAULT_PHOTON_BASE_URL}/api/`;
    }
  }

  /** LOC10: the cache key — (country, normalised q). */
  static cacheKey(query: string, countryCode: string): string {
    return `${countryCode.toUpperCase()}|${collapseWhitespace(query)
      .normalize('NFC')
      .toLowerCase()}`;
  }

  /**
   * Never throws for upstream reasons (LOC8): any failure comes back as
   * `{ suggestions: [], available: false }`.
   */
  async suggest(
    query: string,
    countryCode: string,
  ): Promise<LocationSuggestionsResponseDto> {
    const country = countryCode.toUpperCase();
    const key = LocationsService.cacheKey(query, country);

    const cached = this.cache.get(key);
    if (cached) return { suggestions: cached, available: true };

    if (Date.now() < this.upstreamUnavailableUntil) {
      return { suggestions: [], available: false };
    }

    let pending = this.inFlight.get(key);
    if (!pending) {
      // The normalised text is what's sent, so a cached entry is exactly the
      // answer to the query it's keyed by.
      const normalisedQuery = key.slice(key.indexOf('|') + 1);
      pending = this.fetchFromUpstream(normalisedQuery, country).finally(() => {
        this.inFlight.delete(key);
      });
      this.inFlight.set(key, pending);
    }

    const suggestions = await pending;
    if (suggestions === null) return { suggestions: [], available: false };
    return { suggestions, available: true };
  }

  /**
   * QA JOB-04: "Use my location" on Post a Job sent the customer's exact
   * coordinates from the browser straight to a third-party geocoder. The
   * lookup now goes through here, and only the point rounded to 3 decimal
   * places (about 100 m) leaves JinVa. Never throws for upstream reasons.
   */
  async reverse(lat: number, lon: number): Promise<ReverseLocationResponseDto> {
    if (Date.now() < this.upstreamUnavailableUntil) {
      return { label: null, available: false };
    }
    const params = new URLSearchParams({
      lat: lat.toFixed(3),
      lon: lon.toFixed(3),
      lang: PHOTON_LANG,
      limit: '1',
    });
    const url = `${this.endpoint.replace(/api\/$/, 'reverse')}?${params.toString()}`;
    try {
      const response = await firstValueFrom(
        this.http.get<unknown>(url, {
          headers: {
            'User-Agent': PHOTON_USER_AGENT,
            Accept: 'application/json',
          },
          timeout: PHOTON_TIMEOUT_MS,
          signal: AbortSignal.timeout(PHOTON_TIMEOUT_MS),
          maxRedirects: 0,
          maxContentLength: PHOTON_MAX_RESPONSE_BYTES,
          responseType: 'json',
          withCredentials: false,
        }),
      );
      return {
        label: LocationsService.reverseLabel(response.data),
        available: true,
      };
    } catch (error: unknown) {
      this.recordFailure(error);
      return { label: null, available: false };
    }
  }

  /** "Street, Area, Town, Region" from Photon's first feature, without repeats. */
  static reverseLabel(body: unknown): string | null {
    const features = (body as { features?: unknown } | null)?.features;
    if (!Array.isArray(features) || features.length === 0) return null;
    const p =
      (features[0] as { properties?: Record<string, unknown> }).properties ??
      {};
    const text = (k: string) => {
      const value = p[k];
      return typeof value === 'string' ? value.trim() : '';
    };
    const parts = [
      text('street') || text('name'),
      text('district') || text('locality'),
      text('city'),
      text('state'),
    ].filter(Boolean);
    const unique = parts.filter((v, i) => parts.indexOf(v) === i);
    return unique.length ? unique.join(', ') : null;
  }

  /** Resolves to `null` on any upstream failure; never rejects. */
  private async fetchFromUpstream(
    query: string,
    country: string,
  ): Promise<LocationSuggestionDto[] | null> {
    const url = this.buildUrl(query, country);
    try {
      const response = await firstValueFrom(
        this.http.get<unknown>(url, {
          // PR1/PR2: only these headers. Nothing from the client request is
          // available here to forward in the first place.
          headers: {
            'User-Agent': PHOTON_USER_AGENT,
            Accept: 'application/json',
          },
          timeout: PHOTON_TIMEOUT_MS,
          signal: AbortSignal.timeout(PHOTON_TIMEOUT_MS),
          maxRedirects: 0,
          maxContentLength: PHOTON_MAX_RESPONSE_BYTES,
          responseType: 'json',
          withCredentials: false,
        }),
      );
      const suggestions = this.mapFeatures(response.data, country);
      this.cache.set(LocationsService.cacheKey(query, country), suggestions);
      return suggestions;
    } catch (error: unknown) {
      this.recordFailure(error);
      return null;
    }
  }

  private buildUrl(query: string, country: string): string {
    const params = new URLSearchParams();
    params.set('q', query);
    params.set('countrycode', country);
    for (const layer of PHOTON_LAYERS) params.append('layer', layer);
    params.set('limit', String(PHOTON_RESULT_LIMIT));
    params.set('lang', PHOTON_LANG);
    return `${this.endpoint}?${params.toString()}`;
  }

  /**
   * PR5: logs only *that* the upstream failed and how (status or error code),
   * never the query, URL or caller, and starts a short cooldown (R10).
   */
  private recordFailure(error: unknown): void {
    let cooldownMs = UPSTREAM_COOLDOWN_AFTER_ERROR_MS;
    let reason = 'error';

    if (error instanceof UpstreamPayloadError) {
      reason = 'unexpected payload';
    } else if (isHttpError(error)) {
      const status = error.response?.status;
      if (status === 429) {
        reason = 'status 429';
        const retryAfter = Number(error.response?.headers?.['retry-after']);
        cooldownMs =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter * 1_000, UPSTREAM_MAX_COOLDOWN_MS)
            : UPSTREAM_COOLDOWN_AFTER_429_MS;
      } else if (status) {
        reason = `status ${status}`;
      } else {
        reason = error.code ?? 'network error';
      }
    } else if (error instanceof Error && error.name) {
      reason = error.name;
    }

    this.upstreamUnavailableUntil = Date.now() + cooldownMs;
    this.logger.warn(
      `Location suggestion upstream unavailable (${reason}); returning no suggestions for ${Math.round(cooldownMs / 1_000)}s.`,
    );
  }

  /** LOC10 mapping from Photon's `name/city/state/countrycode`, plus R17's filter. */
  private mapFeatures(body: unknown, country: string): LocationSuggestionDto[] {
    const features =
      typeof body === 'object' && body !== null
        ? (body as { features?: unknown }).features
        : undefined;
    if (!Array.isArray(features)) throw new UpstreamPayloadError();

    const seen = new Set<string>();
    const out: LocationSuggestionDto[] = [];

    for (const feature of features) {
      const props: PhotonProperties | undefined =
        typeof feature === 'object' && feature !== null
          ? ((feature as { properties?: PhotonProperties }).properties ??
            undefined)
          : undefined;
      if (!props || !isPlaceFeature(props)) continue;

      const name =
        typeof props.name === 'string' ? collapseWhitespace(props.name) : '';
      if (!name) continue;

      const countryCode =
        typeof props.countrycode === 'string'
          ? props.countrycode.trim().toUpperCase()
          : '';
      if (countryCode !== country) continue;

      const region = normaliseRegion(
        typeof props.state === 'string' ? props.state : null,
        country,
      );

      const rawCity =
        typeof props.city === 'string' ? collapseWhitespace(props.city) : '';
      const city =
        rawCity &&
        rawCity.toLowerCase() !== name.toLowerCase() &&
        rawCity.toLowerCase() !== region?.toLowerCase()
          ? rawCity
          : undefined;

      const dedupeKey = [name, city ?? '', region ?? '']
        .join('|')
        .toLowerCase();
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      out.push({
        name,
        region,
        ...(city ? { city } : {}),
        countryCode,
      });
      if (out.length >= PHOTON_RESULT_LIMIT) break;
    }

    return out;
  }
}
