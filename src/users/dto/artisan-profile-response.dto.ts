import { ApiProperty } from '@nestjs/swagger';
import { Expose, Transform, Type } from 'class-transformer';
import { UserResponseDto } from './user-response.dto';
import { ServiceResponseDto } from '@services/dto/service-response.dto';
import { PayoutType } from '@common/types/enums';

/** Masks all but the last 4 characters of a payout account/phone number. */
function maskPayoutAccountNumber(value?: string): string | undefined {
  if (!value) return value;
  const last4 = value.slice(-4);
  return value.length <= 4 ? last4 : `${'•'.repeat(value.length - 4)}${last4}`;
}

export class ArtisanProfileResponseDto {
  @ApiProperty({ example: 1 })
  @Expose()
  id: number;

  @ApiProperty({ required: false })
  @Expose()
  bio?: string;

  @ApiProperty({ example: 5, required: false })
  @Expose()
  experienceYears?: number;

  @ApiProperty({ example: 35.5, required: false })
  @Expose()
  hourlyRate?: number;

  @ApiProperty({
    example: 'GHS',
    description: 'ISO 4217 currency code for the hourly rate',
  })
  @Expose()
  currency!: string;

  @ApiProperty({ example: 'XelleNet Pros', required: false })
  @Expose()
  businessName?: string;

  @ApiProperty({ example: 4.5 })
  @Expose()
  averageRating: number;

  @ApiProperty({ example: 12 })
  @Expose()
  totalReviews: number;

  @ApiProperty({ example: 'AVAILABLE' })
  @Expose()
  availabilityStatus: string;

  @ApiProperty({
    example: false,
    description: 'Whether the artisan has been verified by an admin',
  })
  @Expose()
  isVerified: boolean;

  @ApiProperty({ example: 'Accra, Ghana', required: false })
  @Expose()
  location?: string;

  @ApiProperty({
    example: 25,
    required: false,
    description: 'Service radius in kilometres (F7)',
  })
  @Expose()
  serviceRadiusKm?: number;

  @ApiProperty({
    required: false,
    description: "Artisan's cancellation policy (F6)",
  })
  @Expose()
  cancellationPolicy?: string;

  @ApiProperty({
    example: false,
    description:
      'F3: whether this profile currently meets the minimum bar to appear in search. ' +
      'See `missingFields` for what to fill in when false.',
  })
  @Expose()
  isProfileComplete: boolean;

  @ApiProperty({
    example: ['bio', 'hourlyRate'],
    description:
      'F3: required fields still missing when `isProfileComplete` is false (empty otherwise).',
    type: [String],
  })
  @Expose()
  missingFields: string[];

  @ApiProperty({
    example: PayoutType.MOBILE_MONEY,
    enum: PayoutType,
    required: false,
    description:
      "F5: artisan's payout method type; absent if no payout method has been set yet.",
  })
  @Expose()
  payoutType?: PayoutType;

  @ApiProperty({
    example: 'Kwame Mensah',
    required: false,
    description: 'F5: display name on the payout account/wallet.',
  })
  @Expose()
  payoutAccountName?: string;

  @ApiProperty({
    example: '••••1234',
    required: false,
    description:
      'F5: payout phone/account number, masked to the last 4 characters. Never returned in full.',
  })
  @Expose()
  @Transform(({ value }: { value?: string }) => maskPayoutAccountNumber(value))
  payoutAccountNumber?: string;

  @ApiProperty({
    example: '030',
    required: false,
    description:
      "F5: bank/mobile-money provider code sent to Paystack (e.g. 'MTN', '030').",
  })
  @Expose()
  payoutBankCode?: string;

  @ApiProperty({ type: [ServiceResponseDto], required: false })
  @Expose()
  @Type(() => ServiceResponseDto)
  services?: ServiceResponseDto[];

  @ApiProperty({ type: UserResponseDto })
  @Expose()
  @Type(() => UserResponseDto)
  user: UserResponseDto;

  @ApiProperty()
  @Expose()
  createdAt: Date;

  @ApiProperty()
  @Expose()
  updatedAt: Date;
}
