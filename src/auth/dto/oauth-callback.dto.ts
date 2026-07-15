import { IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
export class OAuthCallbackDto {
    @ApiProperty({ description: 'Authorization code returned by the OAuth provider' })
    @IsString()
    @IsNotEmpty()
    code: string;

    @ApiProperty({ description: 'State parameter to prevent CSRF attacks' })
    @IsString()
    @IsNotEmpty()
    state: string;

    @ApiProperty({ description: 'Error message, if any' })
    @IsOptional()
    @IsString()
    error?: string;

    @ApiProperty({ description: 'Error description, if any' })
    @IsOptional()
    @IsString()
    error_description?: string;
}