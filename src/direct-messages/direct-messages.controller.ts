import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Req,
  UseGuards,
  ParseIntPipe,
  Query,
  DefaultValuePipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { DirectMessagesService } from './direct-messages.service';
import { SendDirectMessageDto } from './dto/send-direct-message.dto';

@ApiTags('Direct Messages')
@Controller('direct-messages')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class DirectMessagesController {
  constructor(private readonly service: DirectMessagesService) {}

  @Get('conversations')
  getConversations(@Req() req: any) {
    return this.service.getConversations(req.user.id);
  }

  @Get(':userId')
  getMessages(
    @Req() req: any,
    @Param('userId', ParseIntPipe) userId: number,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(30), ParseIntPipe) limit: number,
  ) {
    return this.service.getMessages(req.user.id, userId, page, limit);
  }

  @Post(':userId')
  sendMessage(
    @Req() req: any,
    @Param('userId', ParseIntPipe) userId: number,
    @Body() dto: SendDirectMessageDto,
  ) {
    return this.service.sendMessage(req.user.id, userId, dto);
  }

  @Patch(':userId/read')
  @HttpCode(HttpStatus.OK)
  markRead(@Req() req: any, @Param('userId', ParseIntPipe) userId: number) {
    return this.service.markRead(req.user.id, userId);
  }
}
