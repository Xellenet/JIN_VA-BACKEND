import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { NotificationsService } from './notifications.service';
import { GetNotificationsQueryDto } from './dto/get-notifications-query.dto';
import { NotificationResponseDto } from './dto/notification-response.dto';

/**
 * In-app notification feed for the authenticated user.
 * All roles (CUSTOMER, ARTISAN, ADMIN) have access.
 */
@ApiTags('Notifications')
@Controller('notifications')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  /**
   * Returns the count of unread notifications.
   * Lightweight endpoint — useful for polling a badge counter.
   * Declared before /:id routes to prevent `unread-count` being parsed as an ID.
   */
  @Get('unread-count')
  @ApiOperation({ summary: 'Get the number of unread notifications' })
  @ApiOkResponse({ description: 'Unread count', schema: { properties: { count: { type: 'number' } } } })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  getUnreadCount(@Req() req: any) {
    return this.notificationsService.getUnreadCount(req.user.id);
  }

  /**
   * Returns the authenticated user's paginated notification feed.
   * Use the optional `isRead` query param to filter read/unread notifications.
   */
  @Get()
  @ApiOperation({ summary: "Get the user's notifications (paginated)" })
  @ApiOkResponse({ description: 'Notifications retrieved', type: [NotificationResponseDto] })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  findAll(@Req() req: any, @Query() query: GetNotificationsQueryDto) {
    return this.notificationsService.findAll(req.user.id, query);
  }

  /**
   * Marks all unread notifications as read in a single call.
   * Declared before /:id/read to avoid route shadowing.
   */
  @Patch('read-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark all notifications as read' })
  @ApiOkResponse({ description: 'All notifications marked as read' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  markAllRead(@Req() req: any) {
    return this.notificationsService.markAllRead(req.user.id);
  }

  /**
   * Marks a single notification as read.
   */
  @Patch(':id/read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark a single notification as read' })
  @ApiOkResponse({ description: 'Notification marked as read' })
  @ApiNotFoundResponse({ description: 'Notification not found' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  markRead(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.notificationsService.markRead(req.user.id, id);
  }
}
