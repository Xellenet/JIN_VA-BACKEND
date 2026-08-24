import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * AT7: the mandatory reason on both setting and clearing a fraud-review flag.
 * Bounds match the review-moderation reason (10–1000) so the same reason
 * -capture dialog can be reused unchanged on the frontend.
 */
export class FraudFlagDto {
  @ApiProperty({
    example:
      'Three chargebacks from this customer in the last week on the same card.',
    minLength: 10,
    maxLength: 1000,
  })
  @IsString()
  @MinLength(10, { message: 'A reason of at least 10 characters is required.' })
  @MaxLength(1000)
  reason!: string;
}
