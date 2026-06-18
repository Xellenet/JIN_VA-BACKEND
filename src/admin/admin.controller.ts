import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { AdminService } from './admin.service';
import { AdminJobsQueryDto, AdminUsersQueryDto } from './dto/admin-query.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '@common/decorators/roles.decorator';
import { Role } from '@common/types/enums';

@ApiTags('Admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  // ─── Stats ────────────────────────────────────────────────────────────────────

  @Get('stats')
  @ApiOperation({ summary: 'Platform statistics overview' })
  getStats() {
    return this.adminService.getStats();
  }

  // ─── Users ────────────────────────────────────────────────────────────────────

  @Get('users')
  @ApiOperation({ summary: 'List all users with optional role/ban filters' })
  listUsers(@Query() query: AdminUsersQueryDto) {
    return this.adminService.listUsers(query);
  }

  @Get('users/:id')
  @ApiOperation({ summary: 'Get a single user by ID' })
  @ApiParam({ name: 'id', type: Number })
  getUser(@Param('id', ParseIntPipe) id: number) {
    return this.adminService.getUser(id);
  }

  @Patch('users/:id/ban')
  @ApiOperation({ summary: 'Ban a user — blocks all future logins' })
  @ApiParam({ name: 'id', type: Number })
  banUser(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.adminService.banUser(req.user.id, id);
  }

  @Patch('users/:id/unban')
  @ApiOperation({ summary: 'Unban a previously banned user' })
  @ApiParam({ name: 'id', type: Number })
  unbanUser(@Param('id', ParseIntPipe) id: number) {
    return this.adminService.unbanUser(id);
  }

  // ─── Jobs ────────────────────────────────────────────────────────────────────

  @Get('jobs')
  @ApiOperation({ summary: 'List all jobs across all customers' })
  listJobs(@Query() query: AdminJobsQueryDto) {
    return this.adminService.listJobs(query);
  }

  @Patch('jobs/:id/expire')
  @ApiOperation({ summary: 'Force-expire an OPEN job posting' })
  @ApiParam({ name: 'id', type: Number })
  forceExpireJob(@Param('id', ParseIntPipe) id: number) {
    return this.adminService.forceExpireJob(id);
  }

  // ─── Artisans ─────────────────────────────────────────────────────────────────

  @Get('artisans')
  @ApiOperation({ summary: 'List all artisan profiles' })
  listArtisans(
    @Query('page', new ParseIntPipe({ optional: true })) page?: number,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
  ) {
    return this.adminService.listArtisans(page, limit);
  }
}
