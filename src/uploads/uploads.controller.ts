import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseFilePipe,
  Post,
  MaxFileSizeValidator,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { memoryStorage } from 'multer';
import type { Response } from 'express';
import { UploadsService } from './uploads.service';
import { KycMediaService } from './kyc-media.service';
import { PRIVATE_UPLOAD_FOLDERS } from './upload-folders';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '@common/decorators/roles.decorator';
import { Role } from '@common/types/enums';
import type { AuthenticatedRequest } from '@common/types/authenticated-request.type';

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
  constructor(
    private readonly uploadsService: UploadsService,
    private readonly kycMediaService: KycMediaService,
  ) {}

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

  @Post('message-attachment')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage() }))
  @ApiOperation({
    summary:
      'MC4: upload an image to attach to a direct message (any authenticated user, ' +
      '≤ 5 MB, JPEG/PNG only). Returns a URL to pass as `attachmentUrl` on ' +
      'POST /messages (one image per message).',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody(fileField)
  uploadMessageAttachment(
    @UploadedFile(
      new ParseFilePipe({
        validators: [new MaxFileSizeValidator({ maxSize: 5 * MB })],
      }),
    )
    file: Express.Multer.File,
  ) {
    return this.uploadsService.uploadMessageAttachment(file);
  }

  /**
   * The only way to read a KYC document or selfie back, in either storage
   * mode. `documents` and `selfies` are no longer served by the public
   * `/uploads` static mount and never get a public S3/CDN URL minted for them,
   * so this endpoint — bearer token + `ADMIN` role — is the single door.
   *
   * Responds with the raw bytes rather than the usual success envelope, which
   * is why it takes `@Res()`: an `<img>`/lightbox needs image bytes, and the
   * global `ResponseInterceptor` would otherwise wrap them in JSON. Because
   * the header is not sendable by an `<img>` tag, the frontend fetches this
   * with its normal authenticated helper and renders the resulting blob.
   */
  @Get('kyc/:folder/:filename')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary:
      'Stream a KYC identity document or verification selfie (admin only). ' +
      'Responds with raw bytes, not the JSON success envelope, and with ' +
      'Cache-Control: private, no-store. Build the path from the stored ' +
      'reference: "/uploads/documents/<file>" → GET /uploads/kyc/documents/<file>.',
  })
  @ApiParam({ name: 'folder', enum: PRIVATE_UPLOAD_FOLDERS })
  @ApiParam({
    name: 'filename',
    description: 'The stored filename, e.g. "9f1c….jpg". No path separators.',
  })
  @ApiOkResponse({
    description: 'The file bytes, with the stored Content-Type.',
  })
  @ApiForbiddenResponse({ description: 'The caller is not an admin.' })
  @ApiNotFoundResponse({
    description:
      'No such object in either store (also returned for a valid-looking ' +
      'filename that does not exist, so existence is never confirmed).',
  })
  async streamKycMedia(
    @Req() req: AuthenticatedRequest,
    @Param('folder') folder: string,
    @Param('filename') filename: string,
    @Res() res: Response,
  ): Promise<void> {
    const object = await this.kycMediaService.open(
      folder,
      filename,
      req.user.id,
    );

    res.setHeader('Content-Type', object.contentType);
    if (object.contentLength !== undefined) {
      res.setHeader('Content-Length', String(object.contentLength));
    }
    // The opposite of the public folders' year-long immutable caching: an
    // identity document must not sit in a shared proxy, a CDN or a browser
    // disk cache on a shared machine.
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // `filename` is validated against `isSafeMediaFilename` before this point,
    // so it cannot break out of the header value.
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);

    object.stream.on('error', () => {
      // Headers are already out by the time bytes start flowing, so a mid-
      // stream read failure cannot become a JSON error response — drop the
      // connection instead of emitting a truncated body that looks complete.
      res.destroy();
    });
    object.stream.pipe(res);
  }
}
