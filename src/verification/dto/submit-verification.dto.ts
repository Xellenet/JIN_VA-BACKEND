import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { DocumentType } from '@common/types/enums';

export class SubmitVerificationDto {
  @ApiProperty({ enum: DocumentType, example: DocumentType.GHANA_CARD })
  @IsEnum(DocumentType)
  documentType!: DocumentType;

  @ApiPropertyOptional({ example: 'GHA-123456789-0' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  idNumber?: string;

  @ApiPropertyOptional({ example: 'Kofi Mensah Asante' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  fullLegalName?: string;

  @ApiPropertyOptional({ example: '1990-05-14', description: 'ISO 8601 date string' })
  @IsOptional()
  @IsDateString()
  dateOfBirth?: string;

  @ApiProperty({ example: '/uploads/documents/abc.jpg' })
  @IsString()
  @IsNotEmpty()
  documentFrontUrl!: string;

  @ApiPropertyOptional({ example: '/uploads/documents/abc-back.jpg' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  documentBackUrl?: string;

  @ApiProperty({ example: '/uploads/selfies/abc.jpg' })
  @IsString()
  @IsNotEmpty()
  selfieUrl!: string;

  @ApiPropertyOptional({ example: 'Document was issued in 2019.' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  additionalNotes?: string;
}
