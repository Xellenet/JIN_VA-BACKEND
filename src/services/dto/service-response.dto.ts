import { ApiProperty } from '@nestjs/swagger';
import { Expose, Transform } from 'class-transformer';

export class ServiceResponseDto {
  @ApiProperty({ description: 'The unique identifier of the service.' })
  @Expose()
  id!: number;

  @ApiProperty({ description: 'The name of the service.' })
  @Expose()
  name!: string;

  @ApiProperty({
    description: 'The description of the service.',
    required: false,
  })
  @Expose()
  description?: string;

  @ApiProperty({
    description:
      'Typical starting price in GHS, as a decimal string (e.g. "150.00"). null until an admin sets one.',
    required: false,
    nullable: true,
    type: String,
  })
  @Expose()
  // Postgres returns a decimal as "150.00", but a just-saved entity holds the
  // number the admin sent; give every response the same "150.00" form.
  @Transform(({ value }: { value: unknown }) =>
    value == null || value === '' ? null : Number(value).toFixed(2),
  )
  price?: string | null;

  @ApiProperty({
    description:
      'A2: estimated duration in minutes, used to derive a booking endTime.',
    example: 60,
  })
  @Expose()
  estimatedDurationMins!: number;

  @ApiProperty({
    description:
      'false when an admin has hidden the service. Only admins see hidden services in lists.',
    example: true,
  })
  @Expose()
  isActive!: boolean;

  @ApiProperty()
  @Expose()
  createdAt!: Date;

  @ApiProperty()
  @Expose()
  updatedAt!: Date;
}
