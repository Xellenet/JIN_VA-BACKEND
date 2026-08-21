import {
  Controller,
  HttpCode,
  HttpStatus,
  ParseFilePipe,
  Post,
  MaxFileSizeValidator,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { memoryStorage } from 'multer';
import { UploadsService } from './uploads.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '@common/decorators/roles.decorator';
import { Role } from '@common/types/enums';

const MB = 1024 * 1024;

const fileField = {
  schema: {
    type: 'object',
    properties: { file: { type: 'string', format: 'binary' } },
    required: ['file'],
  },
};

@ApiTags('Uploads')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('uploads')
export class UploadsController {
  constructor(private readonly uploadsService: UploadsService) {}

  @Post('avatar')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage() }))
  @ApiOperation({
    summary:
      'Upload a profile avatar (all authenticated users, ≤ 3 MB, JPEG/PNG/WebP)',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody(fileField)
  uploadAvatar(
    @UploadedFile(
      new ParseFilePipe({
        validators: [new MaxFileSizeValidator({ maxSize: 3 * MB })],
      }),
    )
    file: Express.Multer.File,
  ) {
    return this.uploadsService.uploadAvatar(file);
  }

  @Post('document')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @Roles(Role.ARTISAN)
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage() }))
  @ApiOperation({
    summary: 'Upload a KYC document (artisan only, ≤ 10 MB, JPEG/PNG/WebP/PDF)',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody(fileField)
  uploadDocument(
    @UploadedFile(
      new ParseFilePipe({
        validators: [new MaxFileSizeValidator({ maxSize: 10 * MB })],
      }),
    )
    file: Express.Multer.File,
  ) {
    return this.uploadsService.uploadDocument(file);
  }

  @Post('selfie')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @Roles(Role.ARTISAN)
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage() }))
  @ApiOperation({
    summary: 'Upload a KYC selfie (artisan only, ≤ 5 MB, JPEG/PNG/WebP)',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody(fileField)
  uploadSelfie(
    @UploadedFile(
      new ParseFilePipe({
        validators: [new MaxFileSizeValidator({ maxSize: 5 * MB })],
      }),
    )
    file: Express.Multer.File,
  ) {
    return this.uploadsService.uploadSelfie(file);
  }

  @Post('job-attachment')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage() }))
  @ApiOperation({
    summary:
      'J4: upload a job/booking photo attachment (any authenticated user, ≤ 10 MB, JPEG/PNG/WebP). ' +
      'Returns a URL to reference in POST /jobs or POST /bookings.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody(fileField)
  uploadJobAttachment(
    @UploadedFile(
      new ParseFilePipe({
        validators: [new MaxFileSizeValidator({ maxSize: 10 * MB })],
      }),
    )
    file: Express.Multer.File,
  ) {
    return this.uploadsService.uploadJobAttachment(file);
  }

  @Post('review-photo')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage() }))
  @ApiOperation({
    summary:
      'RP1: upload a review photo (any authenticated user, ≤ 5 MB, JPEG/PNG only). ' +
      'Returns a URL to reference in POST /reviews (max 3 per review).',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody(fileField)
  uploadReviewPhoto(
    @UploadedFile(
      new ParseFilePipe({
        validators: [new MaxFileSizeValidator({ maxSize: 5 * MB })],
      }),
    )
    file: Express.Multer.File,
  ) {
    return this.uploadsService.uploadReviewPhoto(file);
  }
}
