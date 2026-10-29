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
import { IsAttachmentUrl } from '@common/validators/is-attachment-url.decorator';

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

  @ApiPropertyOptional({
    example: '1990-05-14',
    description: 'ISO 8601 date string',
  })
  @IsOptional()
  @IsDateString()
  dateOfBirth?: string;

  @ApiProperty({
    example: '/uploads/documents/9f1c2b8e-1111-4000-8000-aaaaaaaaaaaa.jpg',
    description:
      'Front of the identity document, pre-uploaded via POST /uploads/document. ' +
      'Must be a URL that endpoint returned: only /uploads/documents/<uuid> with ' +
      'a .jpg/.png/.webp/.pdf extension is accepted, so another folder ' +
      '(selfies, avatars, portfolio…), an arbitrary external URL, a traversal ' +
      'string or a query string is rejected with a 400.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  @IsAttachmentUrl('documents')
  documentFrontUrl!: string;

  @ApiPropertyOptional({
    example: '/uploads/documents/9f1c2b8e-2222-4000-8000-bbbbbbbbbbbb.jpg',
    description:
      'Back of the identity document, when the document type has one. Same ' +
      'upload endpoint and same accepted shape as `documentFrontUrl`.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  @IsAttachmentUrl('documents')
  documentBackUrl?: string;

  @ApiProperty({
    example: '/uploads/selfies/9f1c2b8e-3333-4000-8000-cccccccccccc.jpg',
    description:
      'Liveness selfie, pre-uploaded via POST /uploads/selfie. Must be a URL ' +
      'that endpoint returned: only /uploads/selfies/<uuid> with a ' +
      '.jpg/.png/.webp extension is accepted. A value from the documents ' +
      'folder is rejected here, and vice versa.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  @IsAttachmentUrl('selfies')
  selfieUrl!: string;

  @ApiPropertyOptional({ example: 'Document was issued in 2019.' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  additionalNotes?: string;
}
