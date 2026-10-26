// src/users/dto/create-address.dto.ts
import { VALIDATION_MESSAGES } from '@common/constants/validation-messages.constants';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateAddressDto {
  @ApiProperty({ example: '123 Main St', description: 'Street address' })
  @IsString()
  @IsNotEmpty({ message: VALIDATION_MESSAGES.STREET_REQUIRED })
  street: string;

  @ApiProperty({ example: 'New York', description: 'City' })
  @IsString()
  @IsNotEmpty({ message: VALIDATION_MESSAGES.CITY_REQUIRED })
  city: string;

  /**
   * QA CUS-03: never stored (addresses have no state column), yet it used to
   * be required, so a client that only sends what the form shows got a 400.
   * Still accepted for older clients.
   */
  @ApiPropertyOptional({
    example: 'Greater Accra',
    description: 'Region or state (not stored)',
  })
  @IsOptional()
  @IsString()
  state?: string;

  @ApiProperty({ example: 'USA', description: 'Country' })
  @IsString()
  @IsNotEmpty({ message: VALIDATION_MESSAGES.COUNTRY_REQUIRED })
  country: string;

  @ApiProperty({ example: '10001', description: 'Zip code' })
  @IsString()
  @IsNotEmpty({ message: VALIDATION_MESSAGES.ZIP_CODE_REQUIRED })
  zipCode: string;
}
