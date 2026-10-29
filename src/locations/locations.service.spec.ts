import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { HttpService } from '@nestjs/axios';
import { of, throwError } from 'rxjs';
import { LocationsService } from './locations.service';
import {
  DEFAULT_PHOTON_BASE_URL,
  PHOTON_USER_AGENT,
} from './locations.constants';

/**
 * PR4: every test here runs against a mocked `HttpService`. Nothing is sent
 * over the network, and the configured base URL is a reserved `.invalid` host
 * so an accidental real call could not reach anyone either. All place text is
 * made up or generic; no person's data appears anywhere.
 */
const TEST_BASE_URL = 'http://photon.invalid';

type Props = Record<string, unknown>;
const feature = (properties: Props) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [0, 0] },
  properties,
});
const place = (overrides: Props = {}) =>
  feature({
    osm_key: 'place',
    osm_value: 'suburb',
    countrycode: 'GH',
    ...overrides,
  });
const body = (...features: unknown[]) => ({
  type: 'FeatureCollection',
  features,
});

function httpError(
  status?: number,
  headers: Record<string, string> = {},
  code?: string,
) {
  return {
    isAxiosError: true,
    code,
    message: 'request failed for http://photon.invalid/api/?q=secret-text',
    config: { url: 'http://photon.invalid/api/?q=secret-text' },
    response: status ? { status, headers } : undefined,
  };
}

describe('LocationsService', () => {
  let get: jest.Mock;
  let service: LocationsService;
  let warn: jest.SpyInstance;
  let log: jest.SpyInstance;
  let nowSpy: jest.SpyInstance;
  let now: number;

  const build = (baseUrl: string | undefined = TEST_BASE_URL) => {
    const http = { get } as unknown as HttpService;
    const config = {
      get: jest.fn((key: string) =>
        key === 'PHOTON_BASE_URL' ? baseUrl : undefined,
      ),
    } as unknown as ConfigService;
    return new LocationsService(http, config);
  };

  beforeEach(() => {
    now = 1_000_000;
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    get = jest.fn().mockReturnValue(of({ data: body() }));
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    service = build();
  });

  it('sends only the point rounded to about 100 m for a reverse lookup (QA JOB-04)', async () => {
    get.mockReturnValueOnce(
      of({ data: { features: [{ properties: { city: 'Accra' } }] } }),
    );

    const result = await service.reverse(5.603716, -0.186964);

    expect(result).toEqual({ label: 'Accra', available: true });
    const [[url]] = get.mock.calls as [[string]];
    expect(url).toContain('/reverse?');
    expect(url).toContain('lat=5.604');
    expect(url).toContain('lon=-0.187');
    expect(url).not.toContain('5.603716');
  });

  afterEach(() => {
    nowSpy.mockRestore();
    warn.mockRestore();
    log.mockRestore();
  });

  describe('outbound request (PR1, PR2, LOC10)', () => {
    it('sends only q, countrycode and the fixed params to <PHOTON_BASE_URL>/api/', async () => {
      await service.suggest('  East   Legon ', 'gh');

      expect(get).toHaveBeenCalledTimes(1);
      const [url] = get.mock.calls[0] as [string];
      const parsed = new URL(url);
      expect(`${parsed.origin}${parsed.pathname}`).toBe(
        `${TEST_BASE_URL}/api/`,
      );
      expect([...parsed.searchParams.entries()]).toEqual([
        ['q', 'east legon'],
        ['countrycode', 'GH'],
        ['layer', 'city'],
        ['layer', 'district'],
        ['layer', 'locality'],
        ['limit', '8'],
        ['lang', 'en'],
      ]);
    });

    it('sends a generic JinVa/<version> User-Agent and no other identifying header', async () => {
      await service.suggest('osu', 'GH');

      const [, options] = get.mock.calls[0] as [
        string,
        Record<string, unknown>,
      ];
      expect(options.headers).toEqual({
        'User-Agent': PHOTON_USER_AGENT,
        Accept: 'application/json',
      });
      expect(PHOTON_USER_AGENT).toMatch(/^JinVa\/\d+\.\d+\.\d+$/);
      expect(PHOTON_USER_AGENT).not.toMatch(/@/);
      expect(options.timeout).toBe(1500);
      expect(options.withCredentials).toBe(false);
    });

    it('falls back to the default base URL when PHOTON_BASE_URL is unset or invalid', () => {
      expect(LocationsService.resolveEndpoint(undefined)).toBe(
        `${DEFAULT_PHOTON_BASE_URL}/api/`,
      );
      expect(LocationsService.resolveEndpoint('not a url')).toBe(
        `${DEFAULT_PHOTON_BASE_URL}/api/`,
      );
      expect(LocationsService.resolveEndpoint('ftp://photon.invalid')).toBe(
        `${DEFAULT_PHOTON_BASE_URL}/api/`,
      );
      expect(
        LocationsService.resolveEndpoint('http://photon.invalid/base/?x=1'),
      ).toBe('http://photon.invalid/base/api/');
    });
  });

  describe('mapping and filtering (LOC3, LOC4, R17)', () => {
    it('maps name/city/state/countrycode and normalises the region onto the GH list', async () => {
      get.mockReturnValue(
        of({
          data: body(
            place({
              name: 'Nhyiaeso',
              city: 'Kumasi',
              state: 'Ashanti Region',
            }),
            place({ name: 'Madina', state: 'greater accra region' }),
            place({
              osm_value: 'city',
              name: 'Kumasi',
              city: 'Kumasi',
              state: 'Ashanti Region',
            }),
          ),
        }),
      );

      const result = await service.suggest('test', 'GH');

      expect(result).toEqual({
        available: true,
        suggestions: [
          {
            name: 'Nhyiaeso',
            city: 'Kumasi',
            region: 'Ashanti',
            countryCode: 'GH',
          },
          { name: 'Madina', region: 'Greater Accra', countryCode: 'GH' },
          { name: 'Kumasi', region: 'Ashanti', countryCode: 'GH' },
        ],
      });
    });

    it('drops facilities and other non-place results', async () => {
      get.mockReturnValue(
        of({
          data: body(
            feature({
              osm_key: 'power',
              osm_value: 'plant',
              name: 'Sample Power Plant',
              countrycode: 'GH',
              state: 'Western Region',
            }),
            feature({
              osm_key: 'man_made',
              osm_value: 'works',
              name: 'Sample Flour Mill',
              countrycode: 'GH',
            }),
            feature({
              osm_key: 'amenity',
              osm_value: 'school',
              name: 'Sample School',
              countrycode: 'GH',
            }),
            feature({ name: 'No Tags', countrycode: 'GH' }),
            feature({
              osm_key: 'boundary',
              osm_value: 'administrative',
              name: 'Sample District',
              countrycode: 'GH',
              state: 'Volta Region',
            }),
            feature({
              osm_key: 'landuse',
              osm_value: 'residential',
              name: 'Sample Residential Area',
              countrycode: 'GH',
            }),
            place({
              osm_value: 'village',
              name: 'Sample Village',
              state: 'Oti Region',
            }),
          ),
        }),
      );

      const { suggestions } = await service.suggest('sample', 'GH');

      expect(suggestions.map((s) => s.name)).toEqual([
        'Sample District',
        'Sample Residential Area',
        'Sample Village',
      ]);
      expect(suggestions[1].region).toBeNull();
    });

    it('drops rows from another country, rows without a name, and duplicates', async () => {
      get.mockReturnValue(
        of({
          data: body(
            place({ name: 'Elsewhere', countrycode: 'TG' }),
            place({ name: '   ' }),
            place({ name: 'Tafo', state: 'Ashanti Region' }),
            place({ name: 'tafo', state: 'Ashanti' }),
            place({ name: 'Tafo', state: 'Eastern Region' }),
          ),
        }),
      );

      const { suggestions } = await service.suggest('tafo', 'GH');

      expect(suggestions).toEqual([
        { name: 'Tafo', region: 'Ashanti', countryCode: 'GH' },
        { name: 'Tafo', region: 'Eastern', countryCode: 'GH' },
      ]);
    });

    it('never guesses a region it cannot match; it only strips the suffix', async () => {
      get.mockReturnValue(
        of({
          data: body(
            place({ name: 'Somewhere', state: 'Imaginary Province' }),
            place({
              name: 'Elsewhere',
              countrycode: 'NG',
              state: 'Lagos State',
            }),
          ),
        }),
      );

      expect(
        (await service.suggest('somewhere', 'GH')).suggestions[0].region,
      ).toBe('Imaginary');
      expect(
        (await service.suggest('elsewhere', 'NG')).suggestions[0].region,
      ).toBe('Lagos');
    });

    it('caps the list at 8 rows', async () => {
      get.mockReturnValue(
        of({
          data: body(
            ...Array.from({ length: 12 }, (_, i) =>
              place({ name: `Place ${i}`, state: 'Volta Region' }),
            ),
          ),
        }),
      );

      expect((await service.suggest('place', 'GH')).suggestions).toHaveLength(
        8,
      );
    });
  });

  describe('cache (LOC10)', () => {
    it('serves a repeat query from the cache, keyed by country + normalised q', async () => {
      get.mockReturnValue(
        of({
          data: body(place({ name: 'Osu', state: 'Greater Accra Region' })),
        }),
      );

      const first = await service.suggest('Osu', 'GH');
      const second = await service.suggest('  osu ', 'gh');

      expect(get).toHaveBeenCalledTimes(1);
      expect(second).toEqual(first);

      await service.suggest('osu', 'TG');
      expect(get).toHaveBeenCalledTimes(2);
    });

    it('caches empty answers but expires entries after 24 hours', async () => {
      await service.suggest('nowhere', 'GH');
      await service.suggest('nowhere', 'GH');
      expect(get).toHaveBeenCalledTimes(1);

      now += 24 * 60 * 60 * 1000 + 1;
      await service.suggest('nowhere', 'GH');
      expect(get).toHaveBeenCalledTimes(2);
    });

    it('shares one upstream call between concurrent identical lookups', async () => {
      const results = await Promise.all([
        service.suggest('kasoa', 'GH'),
        service.suggest('Kasoa', 'GH'),
      ]);
      expect(get).toHaveBeenCalledTimes(1);
      expect(results[0]).toEqual(results[1]);
    });
  });

  describe('graceful failure (LOC8, R10)', () => {
    it.each([
      ['a 5xx', httpError(503)],
      ['a timeout', httpError(undefined, {}, 'ECONNABORTED')],
      ['a network error', httpError(undefined, {}, 'ENOTFOUND')],
      [
        'an abort',
        Object.assign(new Error('aborted'), { name: 'CanceledError' }),
      ],
    ])(
      'returns available:false and no suggestions on %s',
      async (_label, error) => {
        get.mockReturnValue(throwError(() => error));

        await expect(service.suggest('legon', 'GH')).resolves.toEqual({
          suggestions: [],
          available: false,
        });
      },
    );

    it('returns available:false on a payload that is not GeoJSON', async () => {
      get.mockReturnValue(of({ data: '<html>maintenance</html>' }));

      await expect(service.suggest('legon', 'GH')).resolves.toEqual({
        suggestions: [],
        available: false,
      });
    });

    it('does not cache a failure, and skips upstream during a short cooldown', async () => {
      get.mockReturnValueOnce(throwError(() => httpError(502)));

      await service.suggest('legon', 'GH');
      expect(get).toHaveBeenCalledTimes(1);

      // Inside the cooldown: no upstream call.
      await expect(service.suggest('madina', 'GH')).resolves.toEqual({
        suggestions: [],
        available: false,
      });
      expect(get).toHaveBeenCalledTimes(1);

      now += 10_001;
      get.mockReturnValue(
        of({
          data: body(place({ name: 'Legon', state: 'Greater Accra Region' })),
        }),
      );
      const result = await service.suggest('legon', 'GH');
      expect(get).toHaveBeenCalledTimes(2);
      expect(result.available).toBe(true);
      expect(result.suggestions).toHaveLength(1);
    });

    it('honours an upstream Retry-After on a 429', async () => {
      get.mockReturnValueOnce(
        throwError(() => httpError(429, { 'retry-after': '120' })),
      );
      await service.suggest('legon', 'GH');

      now += 61_000;
      await service.suggest('legon', 'GH');
      expect(get).toHaveBeenCalledTimes(1);

      now += 60_000;
      await service.suggest('legon', 'GH');
      expect(get).toHaveBeenCalledTimes(2);
    });
  });

  describe('logging (PR5)', () => {
    it('never logs the query text, the URL or the error object', async () => {
      get.mockReturnValue(throwError(() => httpError(503)));
      await service.suggest('secret-text', 'GH');

      expect(warn).toHaveBeenCalledTimes(1);
      const logged = JSON.stringify([
        warn.mock.calls as unknown[],
        log.mock.calls as unknown[],
      ]);
      expect(logged).not.toContain('secret-text');
      expect(logged).not.toContain('photon.invalid');
      expect(logged).toContain('status 503');
    });

    it('logs nothing on a successful lookup', async () => {
      await service.suggest('secret-text', 'GH');
      expect(warn).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    });
  });
});

describe('LocationsService.reverseLabel (QA JOB-04)', () => {
  it('builds "street, area, town, region" without repeats', () => {
    const body = {
      features: [
        {
          properties: {
            street: 'Oxford Street',
            district: 'Osu',
            city: 'Accra',
            state: 'Greater Accra',
          },
        },
      ],
    };
    expect(LocationsService.reverseLabel(body)).toBe(
      'Oxford Street, Osu, Accra, Greater Accra',
    );
    expect(
      LocationsService.reverseLabel({
        features: [{ properties: { name: 'Accra', city: 'Accra' } }],
      }),
    ).toBe('Accra');
  });

  it('returns null when there is nothing to show', () => {
    expect(LocationsService.reverseLabel({ features: [] })).toBeNull();
    expect(LocationsService.reverseLabel(null)).toBeNull();
  });
});
