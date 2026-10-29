import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** LOC10: one suggestion row. */
export class LocationSuggestionDto {
  @ApiProperty({
    description: 'Place name, as Town should be set when chosen.',
    example: 'Nhyiaeso',
  })
  name: string;

  @ApiProperty({
    description:
      "Region, matched onto the country's Region list where possible (LOC4: " +
      '"Ashanti Region" → "Ashanti"). Unmatched text is returned with only the ' +
      'trailing " Region"/" State"/" Province" removed; null when upstream gave none.',
    example: 'Ashanti',
    nullable: true,
    type: String,
  })
  region: string | null;

  @ApiPropertyOptional({
    description:
      'Parent city, only when upstream gives one that differs from `name` ' +
      '(lets same-name places be told apart: "Nhyiaeso · Kumasi, Ashanti").',
    example: 'Kumasi',
  })
  city?: string;

  @ApiProperty({
    description: 'ISO 3166-1 alpha-2, upper case.',
    example: 'GH',
  })
  countryCode: string;
}

/**
 * The `data` of a 200 from `GET /locations/suggestions`.
 *
 * `available: false` means the suggestion service could not be reached (timeout,
 * 429, 5xx, bad payload, or a short cooldown after one of those). `suggestions`
 * is then always `[]`. LOC8: this is still a 200 and the Town field simply
 * stays free text; the flag only lets the client tell "no match" from "service
 * down" if it ever needs to (the current design treats them the same).
 */
export class LocationSuggestionsResponseDto {
  @ApiProperty({ type: [LocationSuggestionDto] })
  suggestions: LocationSuggestionDto[];

  @ApiProperty({
    description:
      'false when the upstream suggestion service was unavailable; suggestions is then [].',
    example: true,
  })
  available: boolean;
}
