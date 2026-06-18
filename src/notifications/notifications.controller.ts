import {
  Body,
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
import { CustomerNotificationPreferencesResponseDto } from './dto/customer-notification-preferences-response.dto';
import { ArtisanNotificationPreferencesResponseDto } from './dto/artisan-notification-preferences-response.dto';
import { UpdateNotificationPreferencesDto } from './dto/update-notification-preferences.dto';

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
   * Returns the authenticated user's notification preferences.
   * All flags default to true until the user changes them.
   * Declared before dynamic routes to avoid route-shadowing.
   */
  @Get('preferences')
  @ApiOperation({
    summary: 'Get notification preferences',
    description:
      'Returns the caller\'s notification preferences. ' +
      'The shape differs by role — customers see booking/job/payment toggles; ' +
      'artisans see opportunity/application/payment-released toggles. ' +
      'Both roles see the channel toggles (email, SMS, push).',
  })
  @ApiOkResponse({
    description: 'Preferences retrieved (shape varies by role)',
    schema: {
      oneOf: [
        { $ref: '#/components/schemas/CustomerNotificationPreferencesResponseDto' },
        { $ref: '#/components/schemas/ArtisanNotificationPreferencesResponseDto' },
      ],
    },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  getPreferences(@Req() req: any) {
    return this.notificationsService.getPreferences(req.user.id);
  }

  /**
   * Partially updates the authenticated user's notification preferences.
   * Only the supplied flags are updated; omitted flags are unchanged.
   * Role-irrelevant fields are silently ignored.
   */
  @Patch('preferences')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Update notification preferences',
    description:
      'Toggle individual notification types or channels on or off. ' +
      'Only role-relevant fields are applied — artisan-only flags are ignored for customers and vice versa. ' +
      'Send only the fields you want to change; omitted fields remain as-is.',
  })
  @ApiOkResponse({
    description: 'Preferences updated (shape varies by role)',
    schema: {
      oneOf: [
        { $ref: '#/components/schemas/CustomerNotificationPreferencesResponseDto' },
        { $ref: '#/components/schemas/ArtisanNotificationPreferencesResponseDto' },
      ],
    },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  updatePreferences(@Req() req: any, @Body() dto: UpdateNotificationPreferencesDto) {
    return this.notificationsService.updatePreferences(req.user.id, dto);
  }

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
