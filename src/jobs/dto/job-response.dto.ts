import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';
import { Status } from '@common/types/enums';

export class JobCustomerDto {
  @ApiProperty({ example: 5 })
  @Expose()
  id!: number;

  @ApiProperty({ example: 'John' })
  @Expose()
  firstname!: string;

  @ApiProperty({ example: 'Doe' })
  @Expose()
  lastname!: string;
}

export class JobServiceDto {
  @ApiProperty({ example: 1 })
  @Expose()
  id!: number;

  @ApiProperty({ example: 'Plumbing' })
  @Expose()
  name!: string;
}

/**
 * Shape of a single job returned from any jobs endpoint.
 * Customer and service are collapsed to id + name only.
 */
export class JobResponseDto {
  @ApiProperty({ example: 1 })
  @Expose()
  id!: number;

  @ApiProperty({ example: 'Leaky faucet repair' })
  @Expose()
  title!: string;

  @ApiPropertyOptional({ example: 'The kitchen faucet has been leaking for two days.' })
  @Expose()
  description?: string;

  @ApiProperty({ type: () => JobCustomerDto })
  @Expose()
  @Type(() => JobCustomerDto)
  customer!: JobCustomerDto;

  @ApiProperty({ type: () => JobServiceDto })
  @Expose()
  @Type(() => JobServiceDto)
  service!: JobServiceDto;

  @ApiProperty({ example: 'Accra, Ghana' })
  @Expose()
  location!: string;

  @ApiPropertyOptional({ example: 50 })
  @Expose()
  budgetMin?: number;

  @ApiPropertyOptional({ example: 500 })
  @Expose()
  budgetMax?: number;

  @ApiProperty({ example: 'GHS', description: 'ISO 4217 currency code for budget amounts' })
  @Expose()
  currency!: string;

  @ApiPropertyOptional({ example: 5.6037 })
  @Expose()
  latitude?: number;

  @ApiPropertyOptional({ example: -0.187 })
  @Expose()
  longitude?: number;

  @ApiProperty({ enum: Status, example: Status.OPEN })
  @Expose()
  status!: Status;

  @ApiProperty()
  @Expose()
  createdAt!: Date;

  @ApiProperty()
  @Expose()
  updatedAt!: Date;
}
