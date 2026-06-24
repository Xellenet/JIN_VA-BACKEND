import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { DisputesService } from './disputes.service';
import { CreateDisputeDto } from './dto/create-dispute.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '@common/decorators/roles.decorator';
import { Role } from '@common/types/enums';

@ApiTags('Disputes')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.CUSTOMER, Role.ARTISAN)
@Controller('disputes')
export class DisputesController {
  constructor(private readonly disputesService: DisputesService) {}

  @Post()
  @ApiOperation({ summary: 'Raise a dispute on a booking (customer or artisan)' })
  raise(@Req() req: any, @Body() dto: CreateDisputeDto) {
    return this.disputesService.raise(req.user.id, dto);
  }

  @Get('my')
  @ApiOperation({ summary: 'List all disputes I have raised' })
  getMyDisputes(@Req() req: any) {
    return this.disputesService.getMyDisputes(req.user.id);
  }

  @Get('my/:id')
  @ApiOperation({ summary: 'Get a specific dispute I raised' })
  @ApiParam({ name: 'id', type: Number })
  getMyDispute(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.disputesService.getMyDispute(req.user.id, id);
  }
}
