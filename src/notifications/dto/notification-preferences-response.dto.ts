import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

export class NotificationPreferencesResponseDto {
  @Expose() @ApiProperty() id!: number;
  @Expose() @ApiProperty() jobApplicationReceived!: boolean;
  @Expose() @ApiProperty() jobApplicationAccepted!: boolean;
  @Expose() @ApiProperty() jobStarted!: boolean;
  @Expose() @ApiProperty() jobCompletionRequested!: boolean;
  @Expose() @ApiProperty() jobCompleted!: boolean;
  @Expose() @ApiProperty() jobCancelled!: boolean;
  @Expose() @ApiProperty() messageReceived!: boolean;
  @Expose() @ApiProperty() reviewReceived!: boolean;
}
