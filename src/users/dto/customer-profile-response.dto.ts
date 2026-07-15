import { ApiProperty } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';
import { UserResponseDto } from './user-response.dto';
import { ServiceResponseDto } from '@services/dto/service-response.dto';

export class CustomerProfileResponseDto {
  @ApiProperty({ example: 1 })
  @Expose()
  id!: number;

  @ApiProperty({ required: false })
  @Expose()
  bio?: string;

  @ApiProperty({ required: false, type: [ServiceResponseDto] })
  @Expose()
  @Type(() => ServiceResponseDto)
  preferredServices?: ServiceResponseDto[];

  @ApiProperty({ required: false, example: 20 })
  @Expose()
  budgetMin?: number;

  @ApiProperty({ required: false, example: 100 })
  @Expose()
  budgetMax?: number;

  @ApiProperty({ type: UserResponseDto })
  @Expose()
  @Type(() => UserResponseDto)
  user!: UserResponseDto;

  @ApiProperty()
  @Expose()
  createdAt!: Date;

  @ApiProperty()
  @Expose()
  updatedAt!: Date;
}
