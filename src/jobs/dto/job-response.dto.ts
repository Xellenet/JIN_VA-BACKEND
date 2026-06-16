import { ApiProperty } from "@nestjs/swagger";
import { Expose, Type } from "class-transformer";
import { ServiceResponseDto } from "@services/dto/service-response.dto";
import { UserResponseDto } from "@users/dto/user-response.dto"; 
export class JobDataResponseDto {
    @ApiProperty({ description: 'The unique identifier of the job.' })
    @Expose()
    id!: number;

    @ApiProperty({ description: 'Title of the job.' })
    @Expose()
    title!: string;

    @ApiProperty({ description: 'Description of the job.' })
    @Expose()
    description!: string;

    @ApiProperty({ type: ServiceResponseDto })
    @Expose()
    @Type(() => ServiceResponseDto)
    service!: ServiceResponseDto;

    @ApiProperty({ type: UserResponseDto })
    @Expose()
    @Type(() => UserResponseDto)
    customer!: UserResponseDto;

    @ApiProperty({ description: 'The location of the job.' })
    @Expose()
    location!: string;

    @ApiProperty({ description: 'The minimum budget for the job.' })
    @Expose()
    budgetMin?: number;

    @ApiProperty({ description: 'The maximum budget for the job.' })
    @Expose()
    budgetMax?: number;

    @ApiProperty({ description: 'The latitude of the job location.' })
    @Expose()
    latitude?: number;

    @ApiProperty({ description: 'The longitude of the job location.' })
    @Expose()
    longitude?: number;

    @ApiProperty({ description: 'The status of the job.' })
    @Expose()
    status!: string;

    @ApiProperty({ description: 'The date and time when the job was created.' })
    @Expose()
    createdAt!: Date;

    @ApiProperty({ description: 'The date and time when the job was last updated.' })
    @Expose()
    updatedAt!: Date;
}

export class JobResponseDto {
    @ApiProperty({ example: 'Job created successfully' })
    @Expose()
    message!: string;

    @ApiProperty({ type: JobDataResponseDto })
    @Expose()
    @Type(() => JobDataResponseDto)
    data!: JobDataResponseDto;
}