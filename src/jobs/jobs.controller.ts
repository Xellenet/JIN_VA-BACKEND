import { Controller, Get, Post, Body, Patch, Param, Delete , HttpCode, Req, UseGuards} from '@nestjs/common';
import { ApiCreatedResponse, ApiTags } from '@nestjs/swagger';
import { JobsService } from './jobs.service';
import { CreateJobDto } from './dto/create-job.dto';
import { UpdateJobDto } from './dto/update-job.dto';
import { JobResponseDto } from './dto/job-response.dto';
import { JwtAuthGuard } from 'auth/guards/jwt-auth.guard';

/**
 * Jobs Controller
 * Handles all job-related HTTP requests and responses.
 * Provides endpoints for creating, retrieving, updating, and deleting jobs.
 */

@ApiTags('Jobs')
@Controller('jobs')
export class JobsController {
  constructor(private readonly jobsService: JobsService) {}


  /**
   * Create a new job
   * @param createJobDto - Data Transfer Object for creating a job
   * @returns The created job entity
   */
  @Post()
  @HttpCode(201)
  @UseGuards(JwtAuthGuard)
  @ApiCreatedResponse({
    description: 'Job created successfully.',
    type: JobResponseDto,
  })
  create(@Body() createJobDto: CreateJobDto, @Req() req): JobResponseDto | Promise<JobResponseDto> {
    return this.jobsService.create(createJobDto, req.user);
  }

  @Get()
  findAll() {
    return this.jobsService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.jobsService.findOne(+id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateJobDto: UpdateJobDto) {
    return this.jobsService.update(+id, updateJobDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.jobsService.remove(+id);
  }
}
