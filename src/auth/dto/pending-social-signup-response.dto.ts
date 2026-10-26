import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Role } from '@common/types/enums';

/** What the complete-signup page prefills from the pending social signup. */
export class PendingSocialSignupDataDto {
  @ApiProperty({ example: 'john@example.com' })
  email: string;

  @ApiProperty({ example: 'John' })
  firstname: string;

  @ApiProperty({ example: 'Doe' })
  lastname: string;

  @ApiPropertyOptional({
    example: 'https://lh3.googleusercontent.com/a/...',
    nullable: true,
    type: String,
  })
  profilePicture: string | null;

  @ApiProperty({
    enum: [Role.CUSTOMER, Role.ARTISAN],
    nullable: true,
    description:
      'Role preselected from the signup page toggle; `null` when the flow started from the login page and the user must pick.',
  })
  suggestedRole: Role | null;

  @ApiProperty({ example: 'google' })
  provider: string;
}

export class PendingSocialSignupResponseDto {
  @ApiProperty({ example: 'Pending sign-up retrieved' })
  message: string;

  @ApiProperty({ type: PendingSocialSignupDataDto })
  data: PendingSocialSignupDataDto;
}
