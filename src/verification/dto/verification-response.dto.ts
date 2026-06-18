import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';
import { DocumentType, VerificationStatus } from '@common/types/enums';

class ReviewerDto {
  @Expose() @ApiProperty() id!: number;
  @Expose() @ApiProperty() firstname!: string;
  @Expose() @ApiProperty() lastname!: string;
}

class ArtisanProfileSnapshotDto {
  @Expose() @ApiProperty() id!: number;
}

export class VerificationResponseDto {
  @Expose() @ApiProperty() id!: number;

  @Expose()
  @ApiProperty({ type: ArtisanProfileSnapshotDto })
  @Type(() => ArtisanProfileSnapshotDto)
  artisanProfile!: ArtisanProfileSnapshotDto;

  @Expose() @ApiProperty({ enum: DocumentType }) documentType!: DocumentType;

  @Expose() @ApiPropertyOptional() idNumber?: string;

  @Expose() @ApiPropertyOptional() fullLegalName?: string;

  @Expose() @ApiPropertyOptional() dateOfBirth?: string;

  @Expose() @ApiProperty() documentFrontUrl!: string;

  @Expose() @ApiPropertyOptional() documentBackUrl?: string;

  @Expose() @ApiProperty() selfieUrl!: string;

  @Expose() @ApiPropertyOptional() additionalNotes?: string;

  @Expose() @ApiProperty({ enum: VerificationStatus }) status!: VerificationStatus;

  @Expose() @ApiProperty() provider!: string;

  @Expose() @ApiPropertyOptional() providerReference?: string;

  @Expose() @ApiPropertyOptional() adminNotes?: string;

  @Expose() @ApiPropertyOptional() rejectionReason?: string;

  @Expose()
  @ApiPropertyOptional({ type: ReviewerDto })
  @Type(() => ReviewerDto)
  reviewedBy?: ReviewerDto;

  @Expose() @ApiPropertyOptional() reviewedAt?: Date;

  @Expose() @ApiProperty() createdAt!: Date;

  @Expose() @ApiProperty() updatedAt!: Date;
}

export class PaginatedVerificationsResponseDto {
  @ApiProperty({ type: [VerificationResponseDto] })
  data!: VerificationResponseDto[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  totalPages!: number;
}
