// src/users/dto/create-address.dto.ts
import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class CreateAddressDto {
  @ApiProperty({ example: '123 Main St', description: 'Street address' })
  @IsString()
  @IsNotEmpty()
  street: string;

  @ApiProperty({ example: 'New York', description: 'City' })
  @IsString()
  @IsNotEmpty()
  city: string;

  @ApiProperty({ example: 'NY', description: 'State' })
  @IsString()
  @IsNotEmpty()
  state: string;

  @ApiProperty({ example: 'USA', description: 'Country' })
  @IsString()
  @IsNotEmpty()
  country: string;

  @ApiProperty({ example: '10001', description: 'Zip code' })
  @IsString()
  @IsNotEmpty()
  zipCode: string;
}
