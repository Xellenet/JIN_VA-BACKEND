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
import { VARIABLES } from '@common/constants/variables.constants';
import { ServiceResponseDto } from './dto/service-response.dto';


/**
 * Services Controller
 */
@ApiTags('Services')
@Controller('services')
export class ServicesController {
  constructor(private readonly servicesService: ServicesService) {}

  @Post()
  @HttpCode(201)
  @ApiCreatedResponse({ description: VARIABLES.SERVICE_CREATED, type: ServiceResponseDto })
  create(@Body() createServiceDto: CreateServiceDto) {
    return this.servicesService.create(createServiceDto);
  }

  @Get()
  @ApiOkResponse({ description: VARIABLES.ALL_SERVICES_RETRIEVED, type: ServiceResponseDto })
  findAll() {
    return this.servicesService.findAll();
  }

  @Get(':id')
  @ApiOkResponse({ description: VARIABLES.SERVICE_RETRIEVED, type: ServiceResponseDto })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.servicesService.findOne(id);
  }

  @Patch(':id')
  @ApiOkResponse({ description: VARIABLES.SERVICE_UPDATED, type: ServiceResponseDto })
  update(@Param('id', ParseIntPipe) id: number, @Body() updateServiceDto: UpdateServiceDto) {
    return this.servicesService.update(id, updateServiceDto);
  }

  @Delete(':id')
  @ApiOkResponse({ description: VARIABLES.SERVICE_DELETED })
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.servicesService.remove(id);
  }
}
