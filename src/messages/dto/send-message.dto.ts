import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsPositive, IsString, MaxLength, MinLength } from 'class-validator';

export class SendMessageDto {
  @ApiProperty({ description: 'The user ID of the recipient', example: 5 })
  @IsInt()
  @IsPositive()
  recipientId!: number;

  @ApiProperty({ example: 'Hey, are you available this week?' })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  content!: string;
}
