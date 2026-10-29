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
 * qa-report.md MEDIUM: the artisan the customer accepted, once one has been
 * accepted. Absent while the job is still OPEN.
 */
export class JobAcceptedArtisanDto {
  @ApiProperty({ example: 26 })
  @Expose()
  id!: number;

  @ApiProperty({ example: 'Yaw' })
  @Expose()
  firstname!: string;

  @ApiProperty({ example: 'Osei' })
  @Expose()
  lastname!: string;
}

/** J4: a single photo attached to the job. */
export class JobAttachmentDto {
  @ApiProperty({ example: 1 })
  @Expose()
  id!: number;

  @ApiProperty({ example: '/uploads/job-attachments/abc123.jpg' })
  @Expose()
  url!: string;

  @ApiProperty({ example: 'image/jpeg' })
  @Expose()
  fileType!: string;

  @ApiProperty()
  @Expose()
  createdAt!: Date;
}

/** J3: one row of the job's real, chronological status-history timeline. */
export class JobStatusHistoryDto {
  @ApiProperty({ example: 1 })
  @Expose()
  id!: number;

  @ApiPropertyOptional({
    description: 'Null only for the very first row (job creation).',
  })
  @Expose()
  fromStatus?: string | null;

  @ApiProperty()
  @Expose()
  toStatus!: string;

  @ApiProperty({
    description:
      "The acting user's ID as a string, or 'SYSTEM' for cron-driven transitions.",
    example: 'SYSTEM',
  })
  @Expose()
  changedBy!: string;

  @ApiPropertyOptional({
    example: 'auto-completed after 48h — customer did not respond',
  })
  @Expose()
  reason?: string | null;

  @ApiProperty()
  @Expose()
  createdAt!: Date;
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

  @ApiPropertyOptional({
    example: 'The kitchen faucet has been leaking for two days.',
  })
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

  @ApiPropertyOptional({
    type: () => JobAcceptedArtisanDto,
    description:
      'Set once the customer has accepted an application (job.status is ' +
      'PENDING or later). Absent while the job is still OPEN.',
  })
  @Expose()
  @Type(() => JobAcceptedArtisanDto)
  acceptedArtisan?: JobAcceptedArtisanDto;

  @ApiProperty({ example: 'Accra, Ghana' })
  @Expose()
  location!: string;

  @ApiPropertyOptional({ example: 50 })
  @Expose()
  budgetMin?: number;

  @ApiPropertyOptional({ example: 500 })
  @Expose()
  budgetMax?: number;

  @ApiProperty({
    example: 'GHS',
    description: 'ISO 4217 currency code for budget amounts',
  })
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

  @ApiPropertyOptional({
    description: 'Auto-expire deadline (set by the customer at creation)',
  })
  @Expose()
  deadline?: Date;

  @ApiPropertyOptional({
    description:
      'R2: set when this job was created by an artisan confirming a direct Booking ' +
      '(rather than the open-posting apply/accept flow).',
  })
  @Expose()
  bookingId?: number;

  @ApiPropertyOptional({
    description:
      'J2/J3: timestamp the artisan requested completion (set by ' +
      'POST /jobs/:id/request-completion). Only meaningful while status is ' +
      'IN_PROGRESS. Frontend uses this to hide/disable the "Request ' +
      'Completion" button and show a "waiting on customer confirmation" ' +
      'state, including after a page reload.',
  })
  @Expose()
  completionRequestedAt?: Date;

  @ApiPropertyOptional({
    type: () => [JobAttachmentDto],
    description:
      'Populated on GET /jobs/:id and job creation; omitted on list endpoints for performance.',
  })
  @Expose()
  @Type(() => JobAttachmentDto)
  attachments?: JobAttachmentDto[];

  @ApiPropertyOptional({
    type: () => [JobStatusHistoryDto],
    description:
      'J3: the real, chronological status-history timeline. Same broad-read ' +
      'authorization as the rest of this payload (see requirements.md J3). ' +
      'Populated on GET /jobs/:id only; omitted on list endpoints for performance.',
  })
  @Expose()
  @Type(() => JobStatusHistoryDto)
  statusHistory?: JobStatusHistoryDto[];

  @ApiProperty()
  @Expose()
  createdAt!: Date;

  @ApiProperty()
  @Expose()
  updatedAt!: Date;
}
