import { ApiProperty } from '@nestjs/swagger';

export class SavedMobileMoneyDto {
  @ApiProperty({ enum: ['MTN', 'VOD', 'ATL'] }) network!: string;
  @ApiProperty({ example: '024 ••• 0000' }) numberMasked!: string;
  @ApiProperty({ example: '0000' }) last4!: string;
  @ApiProperty() accountName!: string;
  @ApiProperty() nameVerified!: boolean;
}

export class SavedCardDto {
  @ApiProperty({ example: 'visa' }) brand!: string;
  @ApiProperty({ example: '4081' }) last4!: string;
  @ApiProperty() expMonth!: number;
  @ApiProperty() expYear!: number;
  @ApiProperty({ nullable: true, type: String }) bank!: string | null;
  @ApiProperty() expired!: boolean;
}

/** One saved method: labels only, never the number or authorization code. */
export class SavedPaymentMethodDto {
  @ApiProperty() id!: number;
  @ApiProperty({ enum: ['mobile_money', 'card'] }) type!:
    | 'mobile_money'
    | 'card';
  @ApiProperty() isDefault!: boolean;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ type: SavedMobileMoneyDto, nullable: true })
  mobileMoney!: SavedMobileMoneyDto | null;
  @ApiProperty({ type: SavedCardDto, nullable: true })
  card!: SavedCardDto | null;
}

export class PaymentMethodListDto {
  @ApiProperty({ type: [SavedPaymentMethodDto] })
  methods!: SavedPaymentMethodDto[];
  @ApiProperty({ example: 5 }) maxMethods!: number;
  @ApiProperty({
    description:
      'False when saving is switched off on the server (no encryption key).',
  })
  canSave!: boolean;
}
