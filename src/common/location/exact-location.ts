/**
 * Exact location (the customer's map pin) shared by jobs and bookings.
 *
 * Privacy (Act 843): a pin is usually someone's home. Only the people who need
 * to get there may read it, see {@link canSeeExactLocation} and
 * {@link redactExactLocation}. The text `location` (the area label) stays
 * visible wherever it was before.
 */

/** A rectangle around Ghana, with a little margin for the borders and coast. */
export const GHANA_BOUNDS = Object.freeze({
  minLat: 4.5,
  maxLat: 11.2,
  minLon: -3.3,
  maxLon: 1.2,
});

/** Longest landmark note ("Opposite Adum Post Office, blue gate"). */
export const LANDMARK_MAX_LENGTH = 140;

/** GPS accuracy beyond this (metres) is not a fix worth storing. */
export const LOCATION_ACCURACY_MAX_M = 100_000;

/** The fields that make up an exact location, as the API names them. */
export const EXACT_LOCATION_FIELDS = [
  'latitude',
  'longitude',
  'locationAccuracyM',
  'landmark',
] as const;

export type ExactLocationField = (typeof EXACT_LOCATION_FIELDS)[number];

export function isInGhana(lat: number, lon: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= GHANA_BOUNDS.minLat &&
    lat <= GHANA_BOUNDS.maxLat &&
    lon >= GHANA_BOUNDS.minLon &&
    lon <= GHANA_BOUNDS.maxLon
  );
}

/** numeric columns arrive from pg as strings; the API speaks numbers. */
export const decimalToNumber = {
  to: (value?: number | null) => value,
  from: (value?: string | number | null): number | null =>
    value === null || value === undefined ? null : Number(value),
};

/** The parts of a write DTO that carry an exact location. */
export interface ExactLocationInput {
  latitude?: number | null;
  longitude?: number | null;
  locationAccuracyM?: number | null;
  landmark?: string | null;
}

/**
 * The columns to store for an exact-location input. An accuracy without a
 * point means nothing, so it is dropped; a blank landmark is stored as null.
 * Fields the client did not send stay absent (an update leaves them as they
 * were); clearing the point (null) clears its accuracy too.
 */
export interface ExactLocationColumns {
  latitude?: number | null;
  longitude?: number | null;
  locationAccuracyM?: number | null;
  landmark?: string | null;
}

export function exactLocationColumns(
  input: ExactLocationInput,
): ExactLocationColumns {
  const out: ExactLocationColumns = {};
  if (input.latitude !== undefined || input.longitude !== undefined) {
    const has = input.latitude != null && input.longitude != null;
    out.latitude = has ? input.latitude : null;
    out.longitude = has ? input.longitude : null;
    out.locationAccuracyM =
      has && input.locationAccuracyM != null
        ? Math.round(input.locationAccuracyM)
        : null;
  }
  if (input.landmark !== undefined) {
    const text =
      typeof input.landmark === 'string' ? input.landmark.trim() : '';
    out.landmark = text || null;
  }
  return out;
}

/**
 * Removes the exact-location fields from a response object (in place) and
 * returns it. Used for everyone who may only see the area.
 */
export function redactExactLocation<T extends object>(dto: T): T {
  const record = dto as Record<string, unknown>;
  for (const field of EXACT_LOCATION_FIELDS) delete record[field];
  return dto;
}
