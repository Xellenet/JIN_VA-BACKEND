import { ApiProperty } from '@nestjs/swagger';
import { Expose, Transform, Type } from 'class-transformer';
import { UserResponseDto } from './user-response.dto';
import { ServiceResponseDto } from '@services/dto/service-response.dto';
import { PayoutType } from '@common/types/enums';
import { bankNameFor } from '../../payments/bank-list';

/** Artisan fixes (B2/H11): the masked payout destination. */
export interface PayoutDestination {
  type: 'mobile_money' | 'bank';
  label: string;
  last4: string;
  accountName: string | null;
  /**
   * True when `accountName` is the name Paystack's lookup returned, false
   * when the artisan typed it (lookup unavailable), null for methods saved
   * before the lookup existed.
   */
  accountNameVerified: boolean | null;
}

const MOBILE_MONEY_LABELS: Record<string, string> = {
  MTN: 'MTN MoMo',
  VOD: 'Telecel Cash',
  ATL: 'AirtelTigo Money',
};

/**
 * The payout destination as the artisan should see it ("MTN MoMo ••1234"):
 * provider label and last four digits only, never the full number. `null`
 * until a payout method is registered.
 */
export function payoutDestinationOf(profile: {
  payoutType?: PayoutType | string | null;
  payoutAccountNumber?: string | null;
  payoutAccountName?: string | null;
  payoutAccountNameVerified?: boolean | null;
  payoutBankCode?: string | null;
  paystackRecipientCode?: string | null;
}): PayoutDestination | null {
  const number = profile?.payoutAccountNumber?.replace(/\s+/g, '') ?? '';
  if (!profile?.payoutType || !number) return null;
  const code = (profile.payoutBankCode ?? '').trim();
  const isMobile =
    String(profile.payoutType) === String(PayoutType.MOBILE_MONEY);
  const label = isMobile
    ? (MOBILE_MONEY_LABELS[code.toUpperCase()] ?? 'Mobile money')
    : (bankNameFor(code) ?? 'Bank account');
  return {
    type: isMobile ? 'mobile_money' : 'bank',
    label,
    last4: number.slice(-4),
    accountName: profile.payoutAccountName?.trim() || null,
    accountNameVerified:
      typeof profile.payoutAccountNameVerified === 'boolean'
        ? profile.payoutAccountNameVerified
        : null,
  };
}

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

  @ApiProperty({
    example: 34,
    description:
      'D3/P1: number of Job records completed by this artisan (distinct from totalReviews).',
  })
  @Expose()
  completedJobsCount: number;

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
    example: ['hourlyRate', 'location'],
    description:
      'F3: required fields still missing when `isProfileComplete` is false (empty otherwise). ' +
      'Possible keys: `hourlyRate`, `location`, `services`. Bio is optional and never listed (B2).',
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

  @ApiProperty({
    required: false,
    nullable: true,
    example: {
      type: 'mobile_money',
      label: 'MTN MoMo',
      last4: '1234',
      accountName: 'Yaw Osei',
      accountNameVerified: true,
    },
    description:
      'Artisan fixes: masked payout destination (label and last 4 only); null when no payout method is set.',
  })
  @Expose()
  @Transform(({ obj }: { obj: Parameters<typeof payoutDestinationOf>[0] }) =>
    payoutDestinationOf(obj),
  )
  payoutDestination!: PayoutDestination | null;

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
