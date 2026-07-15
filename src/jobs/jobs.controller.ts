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
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '@common/decorators/roles.decorator';
import { Role } from '@common/types/enums';
import { JobsService } from './jobs.service';
import { CreateJobDto } from './dto/create-job.dto';
import { UpdateJobDto } from './dto/update-job.dto';
import { GetJobsQueryDto } from './dto/get-jobs-query.dto';
import { JobResponseDto } from './dto/job-response.dto';
import { CreateApplicationDto } from './dto/create-application.dto';
import { ApplicationResponseDto } from './dto/application-response.dto';

/**
 * Manages the full job lifecycle: posting, browsing, artisan applications,
 * state transitions, and cancellation. All endpoints require a valid JWT.
 *
 * State machine:
 *   OPEN → (artisan applies) → PENDING → IN_PROGRESS → COMPLETED
 *   Any non-terminal state → CANCELLED (customer only)
 */
@ApiTags('Jobs')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('jobs')
export class JobsController {
  constructor(private readonly jobsService: JobsService) {}

  // ─── Job CRUD ────────────────────────────────────────────────────────────────

  /**
   * Creates a new job posting. Restricted to CUSTOMER role.
   *
   * @param createJobDto - Fields required to create the job.
   * @param req          - `req.user` injected by `JwtAuthGuard`.
   */
  @Post()
  @HttpCode(201)
  @UseGuards(RolesGuard)
  @Roles(Role.CUSTOMER)
  @ApiOperation({ summary: 'Post a new job (CUSTOMER only)' })
  @ApiCreatedResponse({ description: 'Job created successfully', type: JobResponseDto })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT' })
  @ApiForbiddenResponse({ description: 'Caller does not have the CUSTOMER role' })
  create(@Body() createJobDto: CreateJobDto, @Req() req: any) {
    return this.jobsService.create(createJobDto, req.user);
  }

  /**
   * Returns a paginated, filtered list of all non-deleted jobs.
   * Accessible to any authenticated user (artisans use this to discover work).
   *
   * @param query - Optional `status`, `serviceId`, `location` filters + `page`/`limit`.
   */
  @Get()
  @ApiOperation({ summary: 'List all jobs with optional filters and pagination' })
  @ApiOkResponse({ description: 'Jobs retrieved successfully', type: [JobResponseDto] })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT' })
  findAll(@Query() query: GetJobsQueryDto) {
    return this.jobsService.findAll(query);
  }

  /**
   * Returns all jobs posted by the authenticated customer.
   * The caller's identity is used as an implicit filter.
   *
   * @param req   - `req.user.id` identifies the customer.
   * @param query - Optional filters + pagination.
   */
  @Get('mine')
  @UseGuards(RolesGuard)
  @Roles(Role.CUSTOMER)
  @ApiOperation({ summary: "List the authenticated customer's own jobs (CUSTOMER only)" })
  @ApiOkResponse({ description: "Customer's jobs retrieved successfully", type: [JobResponseDto] })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT' })
  @ApiForbiddenResponse({ description: 'Caller does not have the CUSTOMER role' })
  findMine(@Req() req: any, @Query() query: GetJobsQueryDto) {
    return this.jobsService.findMine(req.user.id, query);
  }

  /**
   * Returns a single job by its ID with customer and service relations.
   *
   * @param id - Numeric job ID.
   */
  @Get(':id')
  @ApiOperation({ summary: 'Get a single job by ID' })
  @ApiOkResponse({ description: 'Job retrieved successfully', type: JobResponseDto })
  @ApiNotFoundResponse({ description: 'No job found with the given ID' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT' })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.jobsService.findOne(id);
  }

  /**
   * Partially updates a job's content fields.
   * Owner only; job must be OPEN or PENDING. Service category and status are not editable here.
   *
   * @param id           - Numeric job ID.
   * @param updateJobDto - Partial set of updatable fields.
   * @param req          - `req.user.id` used for ownership check.
   */
  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles(Role.CUSTOMER)
  @ApiOperation({ summary: 'Update a job (owner only, OPEN/PENDING state)' })
  @ApiOkResponse({ description: 'Job updated successfully', type: JobResponseDto })
  @ApiNotFoundResponse({ description: 'No job found with the given ID' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT' })
  @ApiForbiddenResponse({ description: 'Caller does not own this job or lacks CUSTOMER role' })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() updateJobDto: UpdateJobDto,
    @Req() req: any,
  ) {
    return this.jobsService.update(id, updateJobDto, req.user.id);
  }

  /**
   * Soft-deletes a job. Owner only; job must be OPEN (no artisan engaged yet).
   *
   * @param id  - Numeric job ID.
   * @param req - `req.user.id` used for ownership check.
   */
  @Delete(':id')
  @HttpCode(200)
  @UseGuards(RolesGuard)
  @Roles(Role.CUSTOMER)
  @ApiOperation({ summary: 'Soft-delete a job (owner only, OPEN state)' })
  @ApiOkResponse({ description: 'Job deleted successfully' })
  @ApiNotFoundResponse({ description: 'No job found with the given ID' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT' })
  @ApiForbiddenResponse({ description: 'Caller does not own this job or lacks CUSTOMER role' })
  remove(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.jobsService.remove(id, req.user.id);
  }

  // ─── Application flow ────────────────────────────────────────────────────────

  /**
   * Submits an artisan's application to an OPEN job.
   * Each artisan may apply to a given job only once.
   *
   * @param id  - The job to apply for.
   * @param dto - Optional quote price and cover message.
   * @param req - `req.user.id` identifies the artisan.
   */
  @Post(':id/apply')
  @HttpCode(201)
  @UseGuards(RolesGuard)
  @Roles(Role.ARTISAN)
  @ApiOperation({ summary: 'Apply to a job (ARTISAN only)' })
  @ApiCreatedResponse({ description: 'Application submitted successfully', type: ApplicationResponseDto })
  @ApiNotFoundResponse({ description: 'No job found with the given ID' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT' })
  @ApiForbiddenResponse({ description: 'Caller does not have the ARTISAN role' })
  applyToJob(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateApplicationDto,
    @Req() req: any,
  ) {
    return this.jobsService.applyToJob(id, req.user.id, dto);
  }

  /**
   * Returns all applications for a job. The job owner (customer) only.
   *
   * @param id  - The job whose applications to list.
   * @param req - `req.user.id` used for ownership check.
   */
  @Get(':id/applications')
  @UseGuards(RolesGuard)
  @Roles(Role.CUSTOMER)
  @ApiOperation({ summary: "List all applications for a job (job owner only)" })
  @ApiOkResponse({ description: 'Applications retrieved successfully', type: [ApplicationResponseDto] })
  @ApiNotFoundResponse({ description: 'No job found with the given ID' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT' })
  @ApiForbiddenResponse({ description: 'Caller does not own this job or lacks CUSTOMER role' })
  getApplications(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.jobsService.getApplications(id, req.user.id);
  }

  /**
   * Accepts one application, rejects the rest, and places a payment hold.
   * Job advances from OPEN → PENDING.
   *
   * @param id    - The job ID.
   * @param appId - The application to accept.
   * @param req   - `req.user.id` used for ownership check.
   */
  @Post(':id/applications/:appId/accept')
  @UseGuards(RolesGuard)
  @Roles(Role.CUSTOMER)
  @ApiOperation({ summary: 'Accept an artisan application (job owner only) — OPEN → PENDING' })
  @ApiOkResponse({ description: 'Application accepted. Job is now PENDING.', type: JobResponseDto })
  @ApiNotFoundResponse({ description: 'Job or application not found' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT' })
  @ApiForbiddenResponse({ description: 'Caller does not own this job or lacks CUSTOMER role' })
  acceptApplication(
    @Param('id', ParseIntPipe) id: number,
    @Param('appId', ParseIntPipe) appId: number,
    @Req() req: any,
  ) {
    return this.jobsService.acceptApplication(id, appId, req.user.id);
  }

  // ─── State transitions ───────────────────────────────────────────────────────

  /**
   * Accepted artisan signals they have started the work. PENDING → IN_PROGRESS.
   *
   * @param id  - The job ID.
   * @param req - `req.user.id` checked against `job.acceptedArtisanId`.
   */
  @Patch(':id/start')
  @UseGuards(RolesGuard)
  @Roles(Role.ARTISAN)
  @ApiOperation({ summary: 'Start a job (accepted artisan only) — PENDING → IN_PROGRESS' })
  @ApiOkResponse({ description: 'Job is now in progress', type: JobResponseDto })
  @ApiNotFoundResponse({ description: 'No job found with the given ID' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT' })
  @ApiForbiddenResponse({ description: 'Caller is not the accepted artisan or lacks ARTISAN role' })
  startJob(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.jobsService.startJob(id, req.user.id);
  }

  /**
   * Artisan signals work is done; customer confirmation is now required.
   * The job stays IN_PROGRESS until the customer calls `POST /jobs/:id/confirm`.
   *
   * @param id  - The job ID.
   * @param req - `req.user.id` checked against `job.acceptedArtisanId`.
   */
  @Patch(':id/request-completion')
  @UseGuards(RolesGuard)
  @Roles(Role.ARTISAN)
  @ApiOperation({ summary: 'Request job completion (accepted artisan only) — awaits customer confirmation' })
  @ApiOkResponse({ description: 'Completion requested. Awaiting customer confirmation.', type: JobResponseDto })
  @ApiNotFoundResponse({ description: 'No job found with the given ID' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT' })
  @ApiForbiddenResponse({ description: 'Caller is not the accepted artisan or lacks ARTISAN role' })
  requestCompletion(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.jobsService.requestCompletion(id, req.user.id);
  }

  /**
   * Customer confirms the work is done. IN_PROGRESS → COMPLETED. Payment is captured.
   * Can only be called after the artisan has called `PATCH /jobs/:id/request-completion`.
   *
   * @param id  - The job ID.
   * @param req - `req.user.id` used for ownership check.
   */
  @Post(':id/confirm')
  @UseGuards(RolesGuard)
  @Roles(Role.CUSTOMER)
  @ApiOperation({ summary: 'Confirm job completion (job owner only) — IN_PROGRESS → COMPLETED' })
  @ApiOkResponse({ description: 'Job completed. Payment released.', type: JobResponseDto })
  @ApiNotFoundResponse({ description: 'No job found with the given ID' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT' })
  @ApiForbiddenResponse({ description: 'Caller does not own this job or lacks CUSTOMER role' })
  confirmCompletion(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.jobsService.confirmCompletion(id, req.user.id);
  }

  /**
   * Cancels a job. Customer only; available while the job is not COMPLETED or CANCELLED.
   * If a payment hold is active it will be released (full refund).
   *
   * @param id  - The job ID.
   * @param req - `req.user.id` used for ownership check.
   */
  @Patch(':id/cancel')
  @UseGuards(RolesGuard)
  @Roles(Role.CUSTOMER)
  @ApiOperation({ summary: 'Cancel a job (job owner only) — any non-terminal state' })
  @ApiOkResponse({ description: 'Job cancelled successfully' })
  @ApiNotFoundResponse({ description: 'No job found with the given ID' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT' })
  @ApiForbiddenResponse({ description: 'Caller does not own this job or lacks CUSTOMER role' })
  cancelJob(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.jobsService.cancelJob(id, req.user.id);
  }
}
