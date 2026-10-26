import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsString, Length } from 'class-validator';
import {
  LOCATION_QUERY_MAX_LENGTH,
  LOCATION_QUERY_MIN_LENGTH,
  LOCATION_SUPPORTED_COUNTRIES,
} from '../locations.constants';
import { collapseWhitespace } from '../utils/region-normalise.util';

/**
 * LOC10: `GET /locations/suggestions?q&country`.
 *
 * `q` is trimmed (and inner whitespace collapsed) before the length check, so
 * " a " is one character and rejected. `country` is upper-cased, so "gh" is
 * accepted as "GH". Messages never echo the submitted value (PR5).
 */
export class LocationSuggestionsQueryDto {
  @ApiProperty({
    description:
      'What the user typed into "Town or area". Trimmed, 2–100 characters.',
    example: 'legon',
    minLength: LOCATION_QUERY_MIN_LENGTH,
    maxLength: LOCATION_QUERY_MAX_LENGTH,
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? collapseWhitespace(value) : value,
  )
  @IsString({ message: 'q must be text' })
  @Length(LOCATION_QUERY_MIN_LENGTH, LOCATION_QUERY_MAX_LENGTH, {
    message: `q must be between ${LOCATION_QUERY_MIN_LENGTH} and ${LOCATION_QUERY_MAX_LENGTH} characters`,
  })
  q: string;

  @ApiProperty({
    description:
      'ISO 3166-1 alpha-2 code of the country selected in the phone picker (LOC2).',
    example: 'GH',
    enum: LOCATION_SUPPORTED_COUNTRIES,
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsIn(LOCATION_SUPPORTED_COUNTRIES, {
    message: 'country must be a supported country code',
  })
  country: string;
}
