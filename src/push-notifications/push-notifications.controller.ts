import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PushNotificationsService } from './push-notifications.service';
import { RegisterDeviceDto } from './dto/register-device.dto';
import { UnregisterDeviceDto } from './dto/unregister-device.dto';

@ApiTags('Push Notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('push')
export class PushNotificationsController {
  constructor(private readonly pushService: PushNotificationsService) {}

  @Post('register')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Register a device token for push notifications' })
  @ApiOkResponse({ description: 'Device registered' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  register(@Req() req: any, @Body() dto: RegisterDeviceDto) {
    return this.pushService.registerDevice(req.user.id, dto);
  }

  @Post('unregister')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unregister a device token (e.g. on logout)' })
  @ApiOkResponse({ description: 'Device unregistered' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  unregister(@Req() req: any, @Body() dto: UnregisterDeviceDto) {
    return this.pushService.unregisterDevice(req.user.id, dto.token);
  }
}
