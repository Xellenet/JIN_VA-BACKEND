import { applyDecorators } from '@nestjs/common';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  GHANA_BOUNDS,
  LANDMARK_MAX_LENGTH,
  LOCATION_ACCURACY_MAX_M,
} from '../location/exact-location';
import { TrimText } from './trim-text.decorator';

type Pair = { latitude?: number | null; longitude?: number | null };

/** Either both halves of the point are sent, or neither (null clears both). */
const pointSent = (o: Pair) => o.latitude != null || o.longitude != null;

const OUTSIDE_GHANA = 'The pinned location must be in Ghana.';

/** Latitude of the pin: required with a longitude, inside Ghana. */
export function IsPinLatitude() {
  return applyDecorators(
    ApiPropertyOptional({
      example: 6.6885,
      nullable: true,
      description:
        `Latitude of the pinned spot (WGS84). Sent together with longitude; must be ` +
        `inside Ghana (${GHANA_BOUNDS.minLat} to ${GHANA_BOUNDS.maxLat}). ` +
        'Only the owner, the hired artisan and admins can read it back.',
    }),
    ValidateIf(pointSent),
    Type(() => Number),
    IsNumber({ allowNaN: false, allowInfinity: false }),
    Min(GHANA_BOUNDS.minLat, { message: OUTSIDE_GHANA }),
    Max(GHANA_BOUNDS.maxLat, { message: OUTSIDE_GHANA }),
  );
}

/** Longitude of the pin: required with a latitude, inside Ghana. */
export function IsPinLongitude() {
  return applyDecorators(
    ApiPropertyOptional({
      example: -1.6244,
      nullable: true,
      description:
        `Longitude of the pinned spot (WGS84). Sent together with latitude; must be ` +
        `inside Ghana (${GHANA_BOUNDS.minLon} to ${GHANA_BOUNDS.maxLon}).`,
    }),
    ValidateIf(pointSent),
    Type(() => Number),
    IsNumber({ allowNaN: false, allowInfinity: false }),
    Min(GHANA_BOUNDS.minLon, { message: OUTSIDE_GHANA }),
    Max(GHANA_BOUNDS.maxLon, { message: OUTSIDE_GHANA }),
  );
}

/** GPS accuracy of the pin, in metres (ignored without a point). */
export function IsPinAccuracy() {
  return applyDecorators(
    ApiPropertyOptional({
      example: 8,
      nullable: true,
      description:
        'How accurate the GPS fix was, in metres, when the pin came from GPS. ' +
        'Rounded to whole metres; ignored without latitude and longitude.',
    }),
    IsOptional(),
    Type(() => Number),
    IsNumber({ allowNaN: false, allowInfinity: false }),
    Min(0),
    Max(LOCATION_ACCURACY_MAX_M),
  );
}

/** A short landmark note to find the door. */
export function IsLandmark() {
  return applyDecorators(
    ApiPropertyOptional({
      example: 'Opposite Adum Post Office, blue gate',
      nullable: true,
      description: `Optional note to find the place (max ${LANDMARK_MAX_LENGTH} characters). Same visibility as the coordinates.`,
    }),
    IsOptional(),
    TrimText(),
    IsString(),
    MaxLength(LANDMARK_MAX_LENGTH),
  );
}
