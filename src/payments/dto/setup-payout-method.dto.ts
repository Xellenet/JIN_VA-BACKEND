import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { ResolvePayoutAccountDto } from './resolve-payout-account.dto';

/**
 * `POST /payments/payout-method`. The server looks the account name up
 * itself and stores that name; `accountName` is only used when the lookup is
 * unavailable, so it is optional here but required in that case (400).
 */
export class SetupPayoutMethodDto extends ResolvePayoutAccountDto {
  @ApiPropertyOptional({
    description:
      'Full name on the account. Ignored when the server can look the name up; required when the lookup is unavailable.',
    example: 'Kofi Asante',
  })
  // A blank name is "no name typed", not a validation error.
  @Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') return value;
    const name = value.replace(/\s+/g, ' ').trim();
    return name === '' ? undefined : name;
  })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  accountName?: string;
}
