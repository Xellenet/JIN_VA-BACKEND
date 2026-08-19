import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsString } from 'class-validator';
import { DevicePlatform } from '@common/types/enums';

export class RegisterDeviceDto {
  @ApiProperty({ example: 'fcm-token-abc123', description: 'FCM or APNS device registration token' })
  @IsString()
  @IsNotEmpty()
  token!: string;

  @ApiProperty({ enum: DevicePlatform, example: DevicePlatform.ANDROID })
  @IsEnum(DevicePlatform)
  platform!: DevicePlatform;
}
