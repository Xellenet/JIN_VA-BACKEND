import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class CreateJobDto {
    @ApiProperty({ example: 'Leaky faucet repair' })
    title!: string;

    @ApiProperty({ example: 'The kitchen faucet is leaking and needs to be fixed.' })
    description!: string;

    @ApiProperty({ example: 1, description: 'ID of the service category for this job' })
    serviceId!: number;

    @ApiProperty({ example: 'Accra, Ghana' })
    location!: string;

    @ApiPropertyOptional({ example: 5, description: 'Minimum budget for the job' })
    budgetMin?: number;

    @ApiPropertyOptional({ example: 50, description: 'Maximum budget for the job' })
    budgetMax?: number;

    @ApiPropertyOptional({ example: 5.6037, description: 'Latitude of the job location' })
    latitude?: number;

    @ApiPropertyOptional({ example: -0.187, description: 'Longitude of the job location' })
    longitude?: number; 


}
