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
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { BookingsService } from './bookings.service';
import { CreateBookingDto } from './dto/create-booking.dto';
import { GetBookingsQueryDto } from './dto/get-bookings-query.dto';
import { RespondBookingDto } from './dto/respond-booking.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '@common/decorators/roles.decorator';
import { Role } from '@common/types/enums';

@ApiTags('Bookings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('bookings')
export class BookingsController {
  constructor(private readonly bookingsService: BookingsService) {}

  // ─── Customer routes ──────────────────────────────────────────────────────────

  @Post()
  @UseGuards(RolesGuard)
  @Roles(Role.CUSTOMER)
  @ApiOperation({ summary: 'Create a booking request (customer only)' })
  create(@Req() req: any, @Body() dto: CreateBookingDto) {
    return this.bookingsService.create(req.user.id, dto);
  }

  @Get('my')
  @UseGuards(RolesGuard)
  @Roles(Role.CUSTOMER)
  @ApiOperation({ summary: 'List my bookings (customer only)' })
  getMyBookings(@Req() req: any, @Query() query: GetBookingsQueryDto) {
    return this.bookingsService.getMyBookings(req.user.id, query);
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles(Role.CUSTOMER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a booking (customer only)' })
  @ApiParam({ name: 'id', type: Number })
  cancel(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.bookingsService.cancel(req.user.id, id);
  }

  @Patch(':id/complete')
  @UseGuards(RolesGuard)
  @Roles(Role.CUSTOMER)
  @ApiOperation({ summary: 'Mark a booking as completed (customer only)' })
  @ApiParam({ name: 'id', type: Number })
  complete(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.bookingsService.complete(req.user.id, id);
  }

  // ─── Artisan routes ────────────────────────────────────────────────────────────

  @Get('artisan')
  @UseGuards(RolesGuard)
  @Roles(Role.ARTISAN)
  @ApiOperation({ summary: 'List bookings for my artisan profile (artisan only)' })
  getArtisanBookings(@Req() req: any, @Query() query: GetBookingsQueryDto) {
    return this.bookingsService.getArtisanBookings(req.user.id, query);
  }

  @Patch(':id/confirm')
  @UseGuards(RolesGuard)
  @Roles(Role.ARTISAN)
  @ApiOperation({ summary: 'Confirm a booking request (artisan only)' })
  @ApiParam({ name: 'id', type: Number })
  confirm(@Req() req: any, @Param('id', ParseIntPipe) id: number, @Body() dto: RespondBookingDto) {
    return this.bookingsService.confirm(req.user.id, id, dto);
  }

  @Patch(':id/decline')
  @UseGuards(RolesGuard)
  @Roles(Role.ARTISAN)
  @ApiOperation({ summary: 'Decline a booking request (artisan only)' })
  @ApiParam({ name: 'id', type: Number })
  decline(@Req() req: any, @Param('id', ParseIntPipe) id: number, @Body() dto: RespondBookingDto) {
    return this.bookingsService.decline(req.user.id, id, dto);
  }

  // ─── Shared ────────────────────────────────────────────────────────────────────

  @Get(':id')
  @ApiOperation({ summary: 'Get a single booking (customer or artisan who owns it)' })
  @ApiParam({ name: 'id', type: Number })
  findOne(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.bookingsService.findOne(id, req.user.id);
  }
}
