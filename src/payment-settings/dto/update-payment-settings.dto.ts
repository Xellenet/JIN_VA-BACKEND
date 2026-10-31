import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, ValidateIf } from 'class-validator';
import { MOMO_NETWORKS, PREFERRED_CHANNELS } from '../payment-settings.enums';
import type { MomoNetwork, PreferredChannel } from '../payment-settings.enums';

/**
 * B5 `PATCH /users/me/payment-settings`. Every field is optional and `null`
 * clears it. Any other key (including `momoNumber`, `userId` or `channels`)
 * is rejected by the global `forbidNonWhitelisted` pipe. Messages never echo
 * the submitted value (SEC-31).
 */
export class UpdatePaymentSettingsDto {
  @ApiPropertyOptional({
    enum: PREFERRED_CHANNELS,
    nullable: true,
    description: 'The checkout method to show first. `null` clears it.',
  })
  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @IsIn([...PREFERRED_CHANNELS], {
    message: 'preferredChannel must be mobile_money, card or null',
  })
  preferredChannel?: PreferredChannel | null;

  @ApiPropertyOptional({
    enum: MOMO_NETWORKS,
    nullable: true,
    description: 'Your mobile money network. `null` clears it.',
  })
  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @IsIn([...MOMO_NETWORKS], {
    message: 'momoNetwork must be MTN, TELECEL, AT or null',
  })
  momoNetwork?: MomoNetwork | null;
}
