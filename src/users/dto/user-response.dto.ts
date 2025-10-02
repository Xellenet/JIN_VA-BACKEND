// src/users/dto/user-response.dto.ts
import { ApiProperty } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';
import { Gender, Role } from '@common/types/enums';
import { AddressResponseDto } from '@users/dto/address-response.dto'; // Create this if needed

export class UserResponseDto {
  @ApiProperty({ example: 1, description: 'Unique identifier of the user' })
  @Expose()
  id: number;

  @ApiProperty({ example: 'john@example.com', description: 'User email address' })
  @Expose()
  email: string;

  @ApiProperty({ example: 'johndoe', description: 'User username', nullable: true })
  @Expose()
  username: string;

  @ApiProperty({ example: 'John', description: 'User first name' })
  @Expose()
  firstname: string;

  @ApiProperty({ example: 'Doe', description: 'User last name' })
  @Expose()
  lastname: string;

  @ApiProperty({
    example: 'MALE',
    description: 'User gender',
    enum: Gender,
    enumName: 'Gender',
  })
  @Expose()
  gender: Gender;

  @ApiProperty({
    example: 'CUSTOMER',
    description: 'User role',
    enum: Role,
    enumName: 'Role',
  })
  @Expose()
  role: Role;

  @ApiProperty({ example: '123-456-7890', description: 'User phone number' })
  @Expose()
  phoneNumber: string;

  @ApiProperty({
    description: 'User addresses',
    type: [AddressResponseDto],
    required: false,
  })
  @Expose()
  @Type(() => AddressResponseDto)
  addresses?: AddressResponseDto[];
}