// src/users/dto/create-address.dto.ts
import { VALIDATION_MESSAGES } from '@common/constants/validation-messages.constants';
import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class CreateAddressDto {
  @ApiProperty({ example: '123 Main St', description: 'Street address' })
  @IsString()
  @IsNotEmpty({ message: VALIDATION_MESSAGES.STREET_REQUIRED })
  street: string;

  @ApiProperty({ example: 'New York', description: 'City' })
  @IsString()
  @IsNotEmpty({ message: VALIDATION_MESSAGES.CITY_REQUIRED })
  city: string;

  @ApiProperty({ example: 'NY', description: 'State' })
  @IsString()
  @IsNotEmpty({ message: VALIDATION_MESSAGES.STATE_REQUIRED })
  state: string;

  @ApiProperty({ example: 'USA', description: 'Country' })
  @IsString()
  @IsNotEmpty({ message: VALIDATION_MESSAGES.COUNTRY_REQUIRED })
  country: string;

  @ApiProperty({ example: '10001', description: 'Zip code' })
  @IsString()
  @IsNotEmpty({ message: VALIDATION_MESSAGES.ZIP_CODE_REQUIRED })
  zipCode: string;
}
