import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsString, MinLength, Matches } from 'class-validator';

export class SetupPayoutMethodDto {
  @ApiProperty({
    enum: ['mobile_money', 'bank'],
    description: 'mobile_money for MTN/Vodafone/AirtelTigo, bank for bank account',
  })
  @IsEnum(['mobile_money', 'bank'])
  type!: 'mobile_money' | 'bank';

  @ApiProperty({ description: 'Full name on the account' })
  @IsString()
  @MinLength(2)
  accountName!: string;

  @ApiProperty({
    description:
      'Phone number for mobile money (e.g. 0241234567), or bank account number',
  })
  @IsString()
  @MinLength(8)
  accountNumber!: string;

  @ApiProperty({
    description:
      "Mobile money: 'MTN' | 'VOD' | 'ATL'. Bank: Paystack bank code (see Paystack /bank?country=ghana).",
    examples: { mtn: { value: 'MTN' }, vodafone: { value: 'VOD' }, airtel: { value: 'ATL' } },
  })
  @IsString()
  @MinLength(2)
  bankCode!: string;
}
