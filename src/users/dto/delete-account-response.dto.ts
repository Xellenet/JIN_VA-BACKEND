import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import { VARIABLES } from '@common/constants/variables.constants';

/**
 * C1.2: what `DELETE /users/me` returns on success.
 *
 * The purge date is server-computed on purpose (C1.5/B3): the client states
 * "you have until <date>" verbatim rather than doing its own "+30 days", so
 * the promise it prints can never drift from what the purge job enforces.
 */
export class DeleteAccountResponseDto {
  @ApiProperty({
    example: '2026-09-07T10:15:00.000Z',
    description: 'When the account was soft-deleted.',
  })
  @Expose()
  deletedAt: Date;

  @ApiProperty({
    example: '2026-10-07T10:15:00.000Z',
    description:
      'When the account and its personal details are permanently purged ' +
      '(`deletedAt` + the retention window). Restoring is possible up to and ' +
      'including this instant.',
  })
  @Expose()
  purgeAt: Date;

  @ApiProperty({
    example: VARIABLES.SOFT_DELETE_RETENTION_DAYS,
    description: 'Length of the recovery window, in days.',
  })
  @Expose()
  retentionDays: number;
}
