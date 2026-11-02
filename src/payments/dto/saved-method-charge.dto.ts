import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsPositive, IsString, Matches } from 'class-validator';

/** `POST /payments/:jobId/charge`. Any other key (a PIN above all) is refused. */
export class ChargeWithSavedMethodDto {
  @ApiProperty({ description: 'One of your saved payment methods' })
  @IsInt()
  @IsPositive()
  paymentMethodId!: number;
}

/** `POST /payments/charges/:reference/otp`: the network's one-time code, not a PIN. */
export class SubmitChargeOtpDto {
  @ApiProperty({ example: '123456', description: '4 to 8 digits' })
  @IsString()
  @Matches(/^\d{4,8}$/, {
    message: 'Enter the code from your text message: 4 to 8 digits.',
  })
  otp!: string;
}
