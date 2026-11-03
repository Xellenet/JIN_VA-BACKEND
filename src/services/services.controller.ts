import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '@common/decorators/roles.decorator';
import { Role } from '@common/types/enums';
import { ServicesService } from './services.service';
import { CreateServiceDto } from './dto/create-service.dto';
import { UpdateServiceDto } from './dto/update-service.dto';
import { GetServicesQueryDto } from './dto/get-services-query.dto';
import { ServiceResponseDto } from './dto/service-response.dto';

/**
 * Manages the catalogue of service categories offered on the platform
 * (e.g. Plumbing, Electrical, Carpentry).
 *
 * Read endpoints (`GET`) are public and require no authentication.
 * Write endpoints (`POST`, `PATCH`, `DELETE`) are restricted to the ADMIN role.
 */
@ApiTags('Services')
@Controller('services')
export class ServicesController {
  constructor(private readonly servicesService: ServicesService) {}

  /**
   * Creates a new service category in the platform catalogue.
   * The `name` field must be unique regardless of case — a duplicate returns
   * 409.
   *
   * @param createServiceDto - Name and optional description for the new service.
   * @returns The created service wrapped in a `{ message, data }` envelope.
   */
  @Post()
  @HttpCode(201)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Create a new service category (ADMIN only)',
    description:
      'Adds a new service type to the platform catalogue. ' +
      'Service names are unique regardless of case (409 on a duplicate). ' +
      'Artisans can later associate their profiles with entries from this catalogue.',
  })
  @ApiCreatedResponse({
    description: 'Service created successfully',
    type: ServiceResponseDto,
  })
  @ApiBadRequestResponse({ description: 'Validation failed' })
  @ApiConflictResponse({
    description: 'A service with this name (in any case) already exists',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT' })
  @ApiForbiddenResponse({ description: 'Caller does not have the ADMIN role' })
  create(@Body() createServiceDto: CreateServiceDto) {
    return this.servicesService.create(createServiceDto);
  }

  /**
   * Returns a paginated list of the visible service categories. Admins can
   * add `includeInactive=true` to also see hidden ones, with usage counts.
   * Supports optional case-insensitive name search via the `search` query param.
   * Defaults to page 1 with up to 100 results per page — sufficient to load
   * the entire catalogue in a single call for most UIs while still capping
   * against runaway queries.
   *
   * @param query - Optional `search`, `page`, and `limit` parameters.
   * @returns Paginated array of service categories.
   */
  @Get()
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({
    summary: 'List all service categories — public',
    description:
      'Returns a paginated, searchable list of service categories. ' +
      'Use the optional `search` param for a case-insensitive name substring match. ' +
      'Default limit is 100 (max 200) — enough to load the full catalogue in one call. ' +
      'Hidden services are left out; an ADMIN may pass `includeInactive=true` to include them ' +
      '(each item then also carries `usage: { artisans, bookings, jobs }`).',
  })
  @ApiOkResponse({
    description: 'Services retrieved successfully',
    type: [ServiceResponseDto],
  })
  findAll(
    @Query() query: GetServicesQueryDto,
    @Req() req: { user?: { role?: Role } },
  ) {
    return this.servicesService.findAll(query, req.user?.role === Role.ADMIN);
  }

  /**
   * Returns a single service category by its numeric ID.
   *
   * @param id - The service ID (integer).
   * @returns The matching service wrapped in a `{ message, data }` envelope.
   */
  @Get(':id')
  @ApiOperation({
    summary: 'Get a single service category by ID — public',
    description:
      'Looks up a service by its primary key. Used by clients when resolving a stored `serviceId` to its full details.',
  })
  @ApiOkResponse({
    description: 'Service retrieved successfully',
    type: ServiceResponseDto,
  })
  @ApiNotFoundResponse({ description: 'No service found with the given ID' })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.servicesService.findOne(id);
  }

  /**
   * Partially updates an existing service category.
   * If the `name` field is supplied, it is validated for uniqueness against
   * all other services (updating with the same name as the current record is allowed).
   *
   * @param id               - The service ID to update.
   * @param updateServiceDto - Fields to update (all optional).
   * @returns The updated service wrapped in a `{ message, data }` envelope.
   */
  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Update a service category (ADMIN only)',
    description:
      'Applies a partial update to an existing service. ' +
      'If a new `name` is provided, it is checked for uniqueness against other services. ' +
      'Passing the same name the record already has is safe and will not raise a conflict.',
  })
  @ApiOkResponse({
    description: 'Service updated successfully',
    type: ServiceResponseDto,
  })
  @ApiNotFoundResponse({ description: 'No service found with the given ID' })
  @ApiBadRequestResponse({ description: 'Validation failed' })
  @ApiConflictResponse({
    description: 'New name is already used by a different service',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT' })
  @ApiForbiddenResponse({ description: 'Caller does not have the ADMIN role' })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() updateServiceDto: UpdateServiceDto,
  ) {
    return this.servicesService.update(id, updateServiceDto);
  }

  /**
   * Permanently deletes a service category that nothing uses. A service that
   * artisans offer, or that jobs or bookings refer to, is refused with 409
   * naming the counts; hide it instead (`PATCH` with `isActive: false`).
   *
   * @param id - The service ID to delete.
   * @returns A `{ message }` confirmation (no data field).
   */
  @Delete(':id')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Delete a service category (ADMIN only)',
    description:
      'Permanently removes a service from the catalogue. ' +
      'This is a hard delete, so it is refused (409) while any artisan offers the service ' +
      'or any job or booking refers to it. Hide such a service with PATCH `isActive: false` instead.',
  })
  @ApiOkResponse({ description: 'Service deleted successfully' })
  @ApiConflictResponse({
    description: 'The service is in use by artisans, jobs or bookings',
  })
  @ApiNotFoundResponse({ description: 'No service found with the given ID' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT' })
  @ApiForbiddenResponse({ description: 'Caller does not have the ADMIN role' })
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.servicesService.remove(id);
  }
}
