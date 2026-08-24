import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';
import {
  DisputeCategory,
  DisputeMoneyAction,
  DisputeOutcome,
  DisputeStatus,
} from '@common/types/enums';

class DisputeUserDto {
  @Expose() @ApiProperty() id!: number;
  @Expose() @ApiProperty() firstname!: string;
  @Expose() @ApiProperty() lastname!: string;
  @Expose() @ApiPropertyOptional() profilePicture?: string;
}

class DisputeBookingDto {
  @Expose() @ApiProperty() id!: number;
  @Expose() @ApiProperty() scheduledDate!: string;
  @Expose() @ApiProperty() status!: string;
  @Expose() @ApiPropertyOptional() agreedPrice?: number;
}

/**
 * Shared shape for both the admin and party-facing dispute reads.
 *
 * `adminNotes` is declared **only** on {@link DisputeResponseDto} (admin) and
 * is deliberately absent from {@link PartyDisputeResponseDto} — DP2 requires
 * a party never see admin-internal notes, and `plainToInstance` with
 * `excludeExtraneousValues` drops anything not `@Expose()`d on the target
 * class, so the omission is enforced by the DTO rather than by a caller
 * remembering to strip it.
 */
export class DisputeResponseDto {
  @Expose() @ApiProperty() id!: number;

  @Expose()
  @ApiProperty({ type: DisputeBookingDto })
  @Type(() => DisputeBookingDto)
  booking!: DisputeBookingDto;

  @Expose()
  @ApiProperty({ type: DisputeUserDto })
  @Type(() => DisputeUserDto)
  raisedBy!: DisputeUserDto;

  @Expose() @ApiProperty() reason!: string;

  /** DR5: `OTHER` for disputes filed before the category column existed. */
  @Expose()
  @ApiProperty({ enum: DisputeCategory })
  category!: DisputeCategory;

  @Expose()
  @ApiProperty({ enum: DisputeStatus })
  status!: DisputeStatus;

  // ─── DR4: the counterparty's side ───────────────────────────────────────────

  @Expose() @ApiPropertyOptional() response?: string;

  @Expose()
  @ApiPropertyOptional({ type: DisputeUserDto })
  @Type(() => DisputeUserDto)
  respondedBy?: DisputeUserDto;

  @Expose() @ApiPropertyOptional() respondedAt?: Date;

  // ─── DR1/DR2: the verdict and its money consequence ─────────────────────────

  @Expose()
  @ApiPropertyOptional({
    enum: DisputeOutcome,
    description: 'Set only once an admin has ruled via the resolve action.',
  })
  outcome?: DisputeOutcome;

  @Expose()
  @ApiPropertyOptional({
    enum: DisputeMoneyAction,
    description:
      'What actually happened to the money. NONE is a real answer (MUTUAL verdict, no linked payment, or a payment already refunded/released).',
  })
  moneyAction?: DisputeMoneyAction;

  @Expose()
  @ApiPropertyOptional({ description: 'GHS amount moved, where any moved.' })
  moneyAmount?: number;

  @Expose()
  @ApiPropertyOptional({
    description: 'The payment the money action was carried out against.',
  })
  moneyPaymentId?: number;

  /** Admin-internal. Never present on the party-facing DTO. */
  @Expose() @ApiPropertyOptional() adminNotes?: string;

  @Expose() @ApiPropertyOptional() resolution?: string;

  @Expose()
  @ApiPropertyOptional({ type: DisputeUserDto })
  @Type(() => DisputeUserDto)
  resolvedBy?: DisputeUserDto;

  @Expose() @ApiPropertyOptional() resolvedAt?: Date;
  @Expose() @ApiProperty() createdAt!: Date;
  @Expose() @ApiProperty() updatedAt!: Date;
}

/**
 * DP2: what a *party* (raiser or counterparty) sees. Identical to the admin
 * shape minus `adminNotes`, plus two derived fields the party surfaces need:
 * which side of the dispute the caller is on, and whether they still owe a
 * response.
 */
export class PartyDisputeResponseDto {
  @Expose() @ApiProperty() id!: number;

  @Expose()
  @ApiProperty({ type: DisputeBookingDto })
  @Type(() => DisputeBookingDto)
  booking!: DisputeBookingDto;

  @Expose()
  @ApiProperty({ type: DisputeUserDto })
  @Type(() => DisputeUserDto)
  raisedBy!: DisputeUserDto;

  @Expose() @ApiProperty() reason!: string;

  @Expose()
  @ApiProperty({ enum: DisputeCategory })
  category!: DisputeCategory;

  @Expose()
  @ApiProperty({ enum: DisputeStatus })
  status!: DisputeStatus;

  @Expose() @ApiPropertyOptional() response?: string;

  @Expose()
  @ApiPropertyOptional({ type: DisputeUserDto })
  @Type(() => DisputeUserDto)
  respondedBy?: DisputeUserDto;

  @Expose() @ApiPropertyOptional() respondedAt?: Date;

  @Expose()
  @ApiPropertyOptional({ enum: DisputeOutcome })
  outcome?: DisputeOutcome;

  @Expose()
  @ApiPropertyOptional({ enum: DisputeMoneyAction })
  moneyAction?: DisputeMoneyAction;

  @Expose() @ApiPropertyOptional() moneyAmount?: number;

  @Expose() @ApiPropertyOptional() resolution?: string;
  @Expose() @ApiPropertyOptional() resolvedAt?: Date;
  @Expose() @ApiProperty() createdAt!: Date;
  @Expose() @ApiProperty() updatedAt!: Date;

  /**
   * Which side of this dispute the authenticated caller is on. Derived, not
   * stored — a dispute is visible to both participants (DP2).
   */
  @Expose()
  @ApiProperty({ enum: ['RAISER', 'COUNTERPARTY'] })
  viewerRole!: 'RAISER' | 'COUNTERPARTY';

  /**
   * DR4: true only when the caller is the counterparty, has not responded yet,
   * and the dispute is still OPEN or UNDER_REVIEW.
   */
  @Expose() @ApiProperty() canRespond!: boolean;
}
