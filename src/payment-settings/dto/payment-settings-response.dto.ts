import { ApiProperty } from '@nestjs/swagger';
import { MOMO_NETWORKS, PREFERRED_CHANNELS } from '../payment-settings.enums';
import type { MomoNetwork, PreferredChannel } from '../payment-settings.enums';

/** B5 response, the same for GET and PATCH. */
export class PaymentSettingsResponseDto {
  @ApiProperty({ enum: PREFERRED_CHANNELS, nullable: true })
  preferredChannel!: PreferredChannel | null;

  @ApiProperty({ enum: MOMO_NETWORKS, nullable: true })
  momoNetwork!: MomoNetwork | null;

  @ApiProperty({
    description: 'Receipts go to the account email. Read-only.',
  })
  receiptEmail!: string;

  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  updatedAt!: string | null;

  @ApiProperty({
    description: 'False while the account is suspended.',
  })
  editable!: boolean;
}
