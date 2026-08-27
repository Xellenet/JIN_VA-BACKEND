import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * DR4: the counterparty's single written response to a dispute filed against
 * them. Same 20–2000 character bounds as the raiser's `reason`, so neither
 * side's account of events is held to a different standard.
 */
export class RespondToDisputeDto {
  @ApiProperty({
    example:
      'I attended on the agreed date but nobody was at the property to let me in.',
    description: "The counterparty's side of the dispute (20–2000 characters).",
  })
  @IsString()
  @MinLength(20, {
    message: 'Please provide a detailed response (at least 20 characters).',
  })
  @MaxLength(2000)
  response!: string;
}
