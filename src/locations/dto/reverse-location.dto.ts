import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsLatitude, IsLongitude } from 'class-validator';

export class ReverseLocationQueryDto {
  @ApiProperty({ example: 5.6037 })
  @Type(() => Number)
  @IsLatitude()
  lat: number;

  @ApiProperty({ example: -0.187 })
  @Type(() => Number)
  @IsLongitude()
  lon: number;
}

export class ReverseLocationResponseDto {
  @ApiProperty({
    description:
      'A readable address for the point, or null when none is known.',
    example: 'Oxford Street, Osu, Accra, Greater Accra',
    nullable: true,
    type: String,
  })
  label: string | null;

  @ApiProperty({
    description:
      'False when the geocoder was unreachable; the label is then null.',
  })
  available: boolean;
}
