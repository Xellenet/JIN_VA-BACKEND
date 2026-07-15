import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '@common/decorators/roles.decorator';
import { Role } from '@common/types/enums';
import { AvailabilityService } from './availability.service';
import { SetAvailabilityStatusDto } from './dto/set-availability-status.dto';
import { CreateAvailabilitySlotDto } from './dto/create-availability-slot.dto';
import { UpdateAvailabilitySlotDto } from './dto/update-availability-slot.dto';
import { ArtisanAvailabilityResponseDto, AvailabilitySlotResponseDto } from './dto/availability-response.dto';

@ApiTags('Availability')
@Controller('availability')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class AvailabilityController {
  constructor(private readonly availabilityService: AvailabilityService) {}

  // ─── Artisan self-management ─────────────────────────────────────────────────

  @Get('my')
  @UseGuards(RolesGuard)
  @Roles(Role.ARTISAN)
  @ApiOperation({
    summary: 'Get own availability schedule',
    description: 'Returns the artisan\'s current status and all their weekly slots (including inactive ones).',
  })
  @ApiOkResponse({ type: ArtisanAvailabilityResponseDto })
  @ApiForbiddenResponse({ description: 'Caller is not an artisan' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT' })
  getMyAvailability(@Req() req: any) {
    return this.availabilityService.getMyAvailability(req.user.id);
  }

  @Put('my/status')
  @UseGuards(RolesGuard)
  @Roles(Role.ARTISAN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Set availability status',
    description: 'Updates the artisan\'s top-level status: AVAILABLE, BUSY, or UNAVAILABLE.',
  })
  @ApiOkResponse({ type: ArtisanAvailabilityResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid status value' })
  @ApiForbiddenResponse({ description: 'Caller is not an artisan' })
  setStatus(@Req() req: any, @Body() dto: SetAvailabilityStatusDto) {
    return this.availabilityService.setStatus(req.user.id, dto);
  }

  @Post('my/slots')
  @UseGuards(RolesGuard)
  @Roles(Role.ARTISAN)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Add a weekly availability slot',
    description:
      'Adds a recurring weekly time slot. ' +
      'Slots on the same day must not overlap. endTime must be after startTime.',
  })
  @ApiCreatedResponse({ type: AvailabilitySlotResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid times or overlap with existing slot' })
  @ApiForbiddenResponse({ description: 'Caller is not an artisan' })
  addSlot(@Req() req: any, @Body() dto: CreateAvailabilitySlotDto) {
    return this.availabilityService.addSlot(req.user.id, dto);
  }

  @Patch('my/slots/:id')
  @UseGuards(RolesGuard)
  @Roles(Role.ARTISAN)
  @ApiOperation({
    summary: 'Update an availability slot',
    description: 'Partially updates a slot. Can also toggle isActive to hide it without deleting.',
  })
  @ApiOkResponse({ type: AvailabilitySlotResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid times or overlap' })
  @ApiNotFoundResponse({ description: 'Slot not found (or belongs to another artisan)' })
  @ApiForbiddenResponse({ description: 'Caller is not an artisan' })
  updateSlot(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateAvailabilitySlotDto,
  ) {
    return this.availabilityService.updateSlot(req.user.id, id, dto);
  }

  @Delete('my/slots/:id')
  @UseGuards(RolesGuard)
  @Roles(Role.ARTISAN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove an availability slot permanently' })
  @ApiOkResponse({ description: 'Slot removed' })
  @ApiNotFoundResponse({ description: 'Slot not found (or belongs to another artisan)' })
  @ApiForbiddenResponse({ description: 'Caller is not an artisan' })
  removeSlot(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.availabilityService.removeSlot(req.user.id, id);
  }

  // ─── Public read ─────────────────────────────────────────────────────────────

  @Get(':artisanProfileId')
  @ApiOperation({
    summary: 'Get an artisan\'s public availability',
    description: 'Returns the artisan\'s status and their active weekly slots. Available to all authenticated users.',
  })
  @ApiOkResponse({ type: ArtisanAvailabilityResponseDto })
  @ApiNotFoundResponse({ description: 'Artisan profile not found' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT' })
  getArtisanAvailability(@Param('artisanProfileId', ParseIntPipe) artisanProfileId: number) {
    return this.availabilityService.getArtisanAvailability(artisanProfileId);
  }
}
