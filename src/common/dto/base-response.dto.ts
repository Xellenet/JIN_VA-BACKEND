// common/dto/base-response.dto.ts
import { ApiProperty } from '@nestjs/swagger';

export class BaseResponseDto<T> {
  @ApiProperty({ example: 'success', description: 'Status of the request' })
  status: string;

  @ApiProperty({ example: 'Request processed successfully' })
  message: string;

  @ApiProperty({ description: 'Response data', type: Object })
  data: T;

  @ApiProperty({
    description: 'Additional metadata',
    example: {
      timestamp: '2025-09-10T15:45:00.123Z',
      path: '/users',
    },
  })
  meta: Record<string, any>;
}
