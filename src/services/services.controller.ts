import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  HttpCode,
} from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { ServicesService } from './services.service';
import { CreateServiceDto } from './dto/create-service.dto';
import { UpdateServiceDto } from './dto/update-service.dto';
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
   * Returns all services, ordered by most recently added.
   *
   * @returns An array of all service categories.
   */
  @Get()
  @ApiOkResponse({ description: SUCCESS_MESSAGES.SERVICE.ALL_RETRIEVED, type: [ServiceResponseDto] })
  findAll() {
    return this.servicesService.findAll();
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
