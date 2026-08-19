import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { VerificationService } from './verification.service';
import { SubmitVerificationDto } from './dto/submit-verification.dto';
import { ApproveVerificationDto, RejectVerificationDto } from './dto/review-verification.dto';
import { GetVerificationsQueryDto } from './dto/get-verifications-query.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '@common/decorators/roles.decorator';
import { Role } from '@common/types/enums';

@ApiTags('Verification')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('verification')
export class VerificationController {
  constructor(private readonly verificationService: VerificationService) {}

  // ─── Artisan routes ──────────────────────────────────────────────────────────

  @Post()
  @UseGuards(RolesGuard)
  @Roles(Role.ARTISAN)
  @ApiOperation({ summary: 'Submit identity verification documents (artisan only)' })
  submit(@Req() req: any, @Body() dto: SubmitVerificationDto) {
    return this.verificationService.submit(req.user.id, dto);
  }

  @Get('me')
  @UseGuards(RolesGuard)
  @Roles(Role.ARTISAN)
  @ApiOperation({ summary: 'Get my latest verification submission (artisan only)' })
  getMyVerification(@Req() req: any) {
    return this.verificationService.getMyVerification(req.user.id);
  }

  // ─── Admin routes ─────────────────────────────────────────────────────────────

  @Get()
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'List all verification submissions (admin only)' })
  findAll(@Query() query: GetVerificationsQueryDto) {
    return this.verificationService.findAll(query);
  }

  @Get(':id')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Get a single verification record (admin only)' })
  @ApiParam({ name: 'id', type: Number })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.verificationService.findOne(id);
  }

  @Patch(':id/start-review')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Move a verification to UNDER_REVIEW (admin only)' })
  @ApiParam({ name: 'id', type: Number })
  startReview(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.verificationService.startReview(req.user.id, id);
  }

  @Patch(':id/approve')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Approve a verification and mark artisan as verified (admin only)' })
  @ApiParam({ name: 'id', type: Number })
  approve(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ApproveVerificationDto,
  ) {
    return this.verificationService.approve(req.user.id, id, dto);
  }

  @Patch(':id/reject')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Reject a verification with a reason (admin only)' })
  @ApiParam({ name: 'id', type: Number })
  reject(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RejectVerificationDto,
  ) {
    return this.verificationService.reject(req.user.id, id, dto);
  }
}
