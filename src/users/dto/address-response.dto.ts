// src/users/dto/address-response.dto.ts
import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

export class AddressResponseDto {
  @ApiProperty({ example: 1, description: 'Unique identifier of the address' })
  @Expose()
  id: number;

  @ApiProperty({ example: '123 Main St', description: 'Street address' })
  @Expose()
  street: string;

  @ApiProperty({ example: 'New York', description: 'City' })
  @Expose()
  city: string;

  @ApiProperty({ example: 'USA', description: 'Country' })
  @Expose()
  country: string;

  @ApiProperty({ example: '10001', description: 'Zip code' })
  @Expose()
  zipCode: string;
}