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
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { DisputesService } from './disputes.service';
import { CreateDisputeDto } from './dto/create-dispute.dto';
import { RespondToDisputeDto } from './dto/respond-dispute.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '@common/decorators/roles.decorator';
import { Role } from '@common/types/enums';
import type { AuthenticatedRequest } from '@common/types/authenticated-request.type';

@ApiTags('Disputes')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.CUSTOMER, Role.ARTISAN)
@Controller('disputes')
export class DisputesController {
  constructor(private readonly disputesService: DisputesService) {}

  @Post()
  @ApiOperation({
    summary: 'Raise a dispute on a booking (customer or artisan)',
  })
  raise(@Req() req: AuthenticatedRequest, @Body() dto: CreateDisputeDto) {
    return this.disputesService.raise(req.user.id, dto);
  }

  @Get('my')
  @ApiOperation({
    summary: 'List every dispute I am a participant of',
    description:
      'DP2: the disputes I raised **and** the ones filed against me. Widened from ' +
      '"disputes I raised" this round — DR4 lets the counterparty respond, which they ' +
      'cannot do if they cannot read the dispute. Strictly a superset of the previous ' +
      'behaviour. Admin-internal notes are never included.',
  })
  getMyDisputes(@Req() req: AuthenticatedRequest) {
    return this.disputesService.getMyDisputes(req.user.id);
  }

  @Get('my/:id')
  @ApiOperation({
    summary: 'Get a specific dispute I am a participant of',
    description:
      'Returns the dispute if the caller raised it **or** is the counterparty on the ' +
      'underlying booking (DP2). Never includes admin-internal notes. A dispute that ' +
      'exists but does not involve the caller returns 404, not 403 — an id is never ' +
      'confirmed to a stranger.',
  })
  @ApiParam({ name: 'id', type: Number })
  getMyDispute(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.disputesService.getMyDispute(req.user.id, id);
  }

  /**
   * DR4: PRD §5.13's "admin sees the artisan's response" had no producer —
   * there was no field, no endpoint, and the counterparty was never even told
   * a dispute existed. This is that endpoint.
   *
   * Only the participant who did *not* file the dispute may respond, only
   * once, and only while the dispute is still OPEN or UNDER_REVIEW.
   */
  @Post(':id/respond')
  @ApiOperation({
    summary: 'Submit my one written response to a dispute filed against me',
  })
  @ApiParam({ name: 'id', type: Number })
  @ApiBadRequestResponse({
    description:
      'The dispute is already RESOLVED/CLOSED, or a response has already been submitted',
  })
  @ApiForbiddenResponse({
    description:
      'The caller raised this dispute — the claim is their statement',
  })
  @ApiNotFoundResponse({
    description: 'No such dispute, or the caller is not a participant of it',
  })
  respond(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RespondToDisputeDto,
  ) {
    return this.disputesService.respond(req.user.id, id, dto);
  }
}
