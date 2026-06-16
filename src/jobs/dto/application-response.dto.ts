import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';
import { UserResponseDto } from '@users/dto/user-response.dto';
import { ApplicationStatus } from '@common/types/enums';

/**
 * Shape of a job application returned from any applications endpoint.
 * Used with `plainToInstance(..., { excludeExtraneousValues: true })`.
 */
export class ApplicationResponseDto {
  @ApiProperty({ example: 1, description: 'Unique application identifier' })
  @Expose()
  id!: number;

  @ApiProperty({ example: 3, description: 'ID of the job this application belongs to' })
  @Expose()
  jobId!: number;

  @ApiProperty({ type: () => UserResponseDto, description: 'Artisan who applied' })
  @Expose()
  @Type(() => UserResponseDto)
  artisan!: UserResponseDto;

  @ApiPropertyOptional({ example: 250, description: 'Bid price proposed by the artisan' })
  @Expose()
  quotePrice?: number;

  @ApiPropertyOptional({
    example: 'I have 5 years of plumbing experience.',
    description: 'Cover message from the artisan',
  })
  @Expose()
  message?: string;

  @ApiProperty({
    enum: ApplicationStatus,
    example: ApplicationStatus.PENDING,
    description: 'Current application status',
  })
  @Expose()
  status!: ApplicationStatus;

  @ApiProperty({ description: 'ISO timestamp when the application was submitted' })
  @Expose()
  createdAt!: Date;
}
