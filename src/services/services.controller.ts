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
} from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ServicesService } from './services.service';
import { CreateServiceDto } from './dto/create-service.dto';
import { UpdateServiceDto } from './dto/update-service.dto';
import { GetServicesQueryDto } from './dto/get-services-query.dto';
import { SUCCESS_MESSAGES } from '@common/constants/success-messages.constants';
import { ServiceResponseDto } from './dto/service-response.dto';

/**
 * Manages the catalogue of services offered on the platform (e.g. Plumbing, Electrical).
 */
@ApiTags('Services')
@Controller('services')
export class ServicesController {
  constructor(private readonly servicesService: ServicesService) {}

  /**
   * Creates a new service category.
   *
   * @param createServiceDto - Name, description, and optional base price.
   * @returns The created service.
   */
  @Post()
  @HttpCode(201)
  @ApiCreatedResponse({ description: SUCCESS_MESSAGES.SERVICE.CREATED, type: ServiceResponseDto })
  create(@Body() createServiceDto: CreateServiceDto) {
    return this.servicesService.create(createServiceDto);
  }

  /**
   * Returns a paginated list of service categories.
   * Supports optional `search` (name substring), `page`, and `limit` query params.
   * Defaults to page 1 with up to 100 results — enough to load the entire catalogue
   * in a single call while still protecting against runaway queries.
   *
   * @param query - Optional search and pagination parameters.
   * @returns Paginated array of service categories.
   */
  @Get()
  @ApiOperation({ summary: 'Get all service categories (paginated, searchable)' })
  @ApiOkResponse({ description: SUCCESS_MESSAGES.SERVICE.ALL_RETRIEVED, type: [ServiceResponseDto] })
  findAll(@Query() query: GetServicesQueryDto) {
    return this.servicesService.findAll(query);
  }

  /**
   * Returns a single service by its ID.
   *
   * @param id - The service ID.
   * @returns The matching service.
   */
  @Get(':id')
  @ApiOkResponse({ description: SUCCESS_MESSAGES.SERVICE.RETRIEVED, type: ServiceResponseDto })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.servicesService.findOne(id);
  }

  /**
   * Partially updates a service.
   *
   * @param id - The service ID to update.
   * @param updateServiceDto - Fields to update.
   * @returns The updated service.
   */
  @Patch(':id')
  @ApiOkResponse({ description: SUCCESS_MESSAGES.SERVICE.UPDATED, type: ServiceResponseDto })
  update(@Param('id', ParseIntPipe) id: number, @Body() updateServiceDto: UpdateServiceDto) {
    return this.servicesService.update(id, updateServiceDto);
  }

  /**
   * Permanently deletes a service.
   *
   * @param id - The service ID to delete.
   * @returns A confirmation message.
   */
  @Delete(':id')
  @ApiOkResponse({ description: SUCCESS_MESSAGES.SERVICE.DELETED })
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.servicesService.remove(id);
  }
}
