import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class UnregisterDeviceDto {
  @ApiProperty({ example: 'fcm-token-abc123', description: 'Device token to remove' })
  @IsString()
  @IsNotEmpty()
  token!: string;
}
