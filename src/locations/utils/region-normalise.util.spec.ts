import {
  normaliseRegion,
  regionMatchKey,
  stripRegionSuffix,
} from './region-normalise.util';
import { REGIONS_BY_COUNTRY } from '../data/regions.data';

describe('region normalisation (LOC4)', () => {
  it('strips a trailing Region / State / Province, case-insensitively', () => {
    expect(stripRegionSuffix('Greater Accra Region')).toBe('Greater Accra');
    expect(stripRegionSuffix('Lagos State')).toBe('Lagos');
    expect(stripRegionSuffix('Sample  province ')).toBe('Sample');
    expect(stripRegionSuffix('Region')).toBe('Region');
  });

  it('builds a case- and diacritic-insensitive key', () => {
    expect(regionMatchKey('Ségou Region')).toBe(regionMatchKey('segou'));
  });

  it('maps onto the exact GH list spelling', () => {
    expect(normaliseRegion('greater accra region', 'GH')).toBe('Greater Accra');
    expect(normaliseRegion('BONO EAST REGION', 'gh')).toBe('Bono East');
    expect(normaliseRegion('Western North', 'GH')).toBe('Western North');
  });

  it('returns stripped text when there is no match or no list, and null for nothing', () => {
    expect(normaliseRegion('Atlantis Region', 'GH')).toBe('Atlantis');
    expect(normaliseRegion('Lagos State', 'NG')).toBe('Lagos');
    expect(normaliseRegion('  ', 'GH')).toBeNull();
    expect(normaliseRegion(undefined, 'GH')).toBeNull();
  });

  it("holds exactly Ghana's 16 regions (LOC7)", () => {
    expect(REGIONS_BY_COUNTRY.GH).toHaveLength(16);
    expect(new Set(REGIONS_BY_COUNTRY.GH).size).toBe(16);
  });
});
