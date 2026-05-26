
import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

export class ServiceResponseDto {
    @ApiProperty({ description: 'The unique identifier of the service.' })
    @Expose()
    id!: number;

    @ApiProperty({ description: 'The name of the service.' })
    @Expose()
    name!: string;

    @ApiProperty({ description: 'The description of the service.', required: false })
    @Expose()
    description?: string;

    @ApiProperty({ description: 'The price of the service.', required: false })
    @Expose()
    price?: number;

    @ApiProperty()
    @Expose()
    createdAt!: Date;

    @ApiProperty()
    @Expose()
    updatedAt!: Date;
}