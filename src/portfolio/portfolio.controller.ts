import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  MaxFileSizeValidator,
  Param,
  ParseFilePipe,
  ParseIntPipe,
  Patch,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
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
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { PortfolioService } from './portfolio.service';
import { CreatePortfolioItemDto } from './dto/create-portfolio-item.dto';
import { ResubmitPortfolioItemDto } from './dto/resubmit-portfolio-item.dto';
import { ReorderPortfolioItemDto } from './dto/reorder-portfolio-item.dto';
import { PortfolioItemResponseDto } from './dto/portfolio-item-response.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '@common/decorators/roles.decorator';
import { Role } from '@common/types/enums';
import type { AuthenticatedRequest } from '@common/types/authenticated-request.type';

const MAX_PORTFOLIO_FILE_BYTES = 50 * 1024 * 1024;
// Generous multer-level cap, comfortably above the 50MB app-level limit —
// this only guards against pathological uploads; the actual 50MB rule is
// enforced below by `ParseFilePipe`/`MaxFileSizeValidator`, which throws a
// clean 400 (not a raw multer abort) with a specific message.
const MAX_MULTIPART_BYTES = 60 * 1024 * 1024;

/**
 * PF2/PF7a: NestJS-native size validation producing a clean 400 with a
 * specific message, consistent with how `UploadsController` validates size
 * elsewhere in this codebase.
 */
function fileSizeValidationPipe() {
  return new ParseFilePipe({
    validators: [
      new MaxFileSizeValidator({
        maxSize: MAX_PORTFOLIO_FILE_BYTES,
        message: 'File exceeds the 50MB size limit.',
      }),
    ],
    fileIsRequired: false,
  });
}

const fileField = {
  schema: {
    type: 'object',
    properties: {
      file: { type: 'string', format: 'binary' },
      tag: { type: 'string' },
      caption: { type: 'string' },
    },
    required: ['file', 'tag'],
  },
};

/**
 * PF1–PF3, PF7a: artisan portfolio upload, fetch, delete, reorder, and resubmission.
 * Admin moderation lives on `AdminController` (`/admin/portfolio/*`, PF4).
 */
@ApiTags('Portfolio')
@Controller('portfolio')
export class PortfolioController {
  constructor(private readonly portfolioService: PortfolioService) {}

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ARTISAN)
  @ApiBearerAuth()
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_MULTIPART_BYTES },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody(fileField)
  @ApiOperation({
    summary:
      'Upload a portfolio item (artisan only, JPEG/PNG/MP4, max 50MB) — created as PENDING',
  })
  @ApiOkResponse({ type: PortfolioItemResponseDto })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  @ApiForbiddenResponse({
    description: 'Caller does not have the ARTISAN role',
  })
  create(
    @Req() req: AuthenticatedRequest,
    @UploadedFile(fileSizeValidationPipe()) file: Express.Multer.File,
    @Body() dto: CreatePortfolioItemDto,
  ) {
    return this.portfolioService.create(req.user.id, file, dto);
  }

  @Get(':artisanId')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({
    summary:
      "List an artisan's portfolio items (public). Customers only ever see " +
      'APPROVED items; the owning artisan (authenticated) sees all statuses.',
  })
  @ApiParam({ name: 'artisanId', type: Number })
  @ApiOkResponse({ type: [PortfolioItemResponseDto] })
  @ApiNotFoundResponse({ description: 'Artisan profile not found' })
  findByArtisan(
    @Req() req: AuthenticatedRequest,
    @Param('artisanId', ParseIntPipe) artisanId: number,
  ) {
    return this.portfolioService.findByArtisan(artisanId, req.user);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ARTISAN)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Delete one of the authenticated artisan's own portfolio items",
  })
  @ApiParam({ name: 'id', type: Number })
  @ApiNotFoundResponse({
    description: 'Item not found or not owned by the caller',
  })
  remove(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.portfolioService.remove(req.user.id, id);
  }

  @Patch(':id/reorder')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ARTISAN)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Persist a new sortOrder for one of the artisan's own portfolio items",
  })
  @ApiParam({ name: 'id', type: Number })
  @ApiOkResponse({ type: PortfolioItemResponseDto })
  @ApiNotFoundResponse({
    description: 'Item not found or not owned by the caller',
  })
  reorder(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ReorderPortfolioItemDto,
  ) {
    return this.portfolioService.reorder(req.user.id, id, dto);
  }

  @Patch(':id/resubmit')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ARTISAN)
  @ApiBearerAuth()
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_MULTIPART_BYTES },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody(fileField)
  @ApiOperation({
    summary:
      'PF7a: resubmit a REJECTED item with a new file — resets it to PENDING and clears the prior rejectionReason',
  })
  @ApiParam({ name: 'id', type: Number })
  @ApiOkResponse({ type: PortfolioItemResponseDto })
  @ApiNotFoundResponse({
    description: 'Item not found or not owned by the caller',
  })
  resubmit(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
    @UploadedFile(fileSizeValidationPipe()) file: Express.Multer.File,
    @Body() dto: ResubmitPortfolioItemDto,
  ) {
    return this.portfolioService.resubmit(req.user.id, id, file, dto);
  }
}
