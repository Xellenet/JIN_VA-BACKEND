import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { plainToInstance } from 'class-transformer';
import { Repository } from 'typeorm';
import { ArtisanVerification } from './entities/artisan-verification.entity';
import { VerificationProviderFactory } from './providers/verification-provider.factory';
import { SubmitVerificationDto } from './dto/submit-verification.dto';
import { ApproveVerificationDto, RejectVerificationDto } from './dto/review-verification.dto';
import { GetVerificationsQueryDto } from './dto/get-verifications-query.dto';
import { VerificationResponseDto } from './dto/verification-response.dto';
import { VerificationStatus } from '@common/types/enums';
import { APP_EVENTS } from '@common/events/app.events';
import type {
  ArtisanProfileVerifiedPayload,
  ArtisanVerificationRejectedPayload,
  ArtisanVerificationSubmittedPayload,
} from '@common/events/app.events';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';

@Injectable()
export class VerificationService {
  private readonly logger = new Logger(VerificationService.name);

  constructor(
    @InjectRepository(ArtisanVerification)
    private readonly repo: Repository<ArtisanVerification>,
    @InjectRepository(ArtisanProfile)
    private readonly profileRepo: Repository<ArtisanProfile>,
    private readonly providerFactory: VerificationProviderFactory,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async submit(userId: number, dto: SubmitVerificationDto) {
    const profile = await this.profileRepo.findOne({
      where: { user: { id: userId } },
      relations: ['user'],
    });
    if (!profile) throw new NotFoundException('Artisan profile not found.');
    if (profile.isVerified) {
      throw new BadRequestException('Your profile is already verified.');
    }

    const active = await this.repo.findOne({
      where: [
        { artisanProfileId: profile.id, status: VerificationStatus.PENDING },
        { artisanProfileId: profile.id, status: VerificationStatus.UNDER_REVIEW },
      ],
    });
    if (active) {
      throw new BadRequestException(
        'You already have a verification submission under review. Please wait for the outcome.',
      );
    }

    const provider = this.providerFactory.getProvider();
    const verification = this.repo.create({
      artisanProfile: profile,
      artisanProfileId: profile.id,
      documentType: dto.documentType,
      idNumber: dto.idNumber,
      fullLegalName: dto.fullLegalName,
      dateOfBirth: dto.dateOfBirth,
      documentFrontUrl: dto.documentFrontUrl,
      documentBackUrl: dto.documentBackUrl,
      selfieUrl: dto.selfieUrl,
      additionalNotes: dto.additionalNotes,
      provider: provider.providerName,
    });

    const saved = await this.repo.save(verification);

    try {
      const result = await provider.initiate({
        verificationId: saved.id,
        artisanProfileId: profile.id,
        documentType: dto.documentType,
        documentFrontUrl: dto.documentFrontUrl,
        documentBackUrl: dto.documentBackUrl,
        selfieUrl: dto.selfieUrl,
        idNumber: dto.idNumber,
        fullLegalName: dto.fullLegalName,
        dateOfBirth: dto.dateOfBirth,
      });

      saved.status = result.initialStatus;
      if (result.providerReference) saved.providerReference = result.providerReference;
      if (result.rawResponse) saved.providerRawResponse = result.rawResponse;
      await this.repo.save(saved);
    } catch (err) {
      this.logger.error(`Provider initiate failed for verification ${saved.id}: ${(err as Error).message}`);
    }

    this.eventEmitter.emit(APP_EVENTS.ARTISAN_VERIFICATION_SUBMITTED, {
      verificationId: saved.id,
      artisanUserId: userId,
      artisanName: `${profile.user.firstname} ${profile.user.lastname}`,
    } as ArtisanVerificationSubmittedPayload);

    return {
      message: 'Verification submitted successfully. You will be notified of the outcome.',
      data: plainToInstance(VerificationResponseDto, saved, { excludeExtraneousValues: true }),
    };
  }

  async getMyVerification(userId: number) {
    const profile = await this.profileRepo.findOne({ where: { user: { id: userId } } });
    if (!profile) throw new NotFoundException('Artisan profile not found.');

    const verification = await this.repo.findOne({
      where: { artisanProfileId: profile.id },
      relations: ['artisanProfile', 'reviewedBy'],
      order: { createdAt: 'DESC' },
    });
    if (!verification) throw new NotFoundException('No verification submission found.');

    return {
      message: 'Verification record retrieved.',
      data: plainToInstance(VerificationResponseDto, verification, { excludeExtraneousValues: true }),
    };
  }

  async findAll(query: GetVerificationsQueryDto) {
    const page  = query.page  ?? 1;
    const limit = query.limit ?? 20;

    const qb = this.repo
      .createQueryBuilder('v')
      .leftJoinAndSelect('v.artisanProfile', 'artisanProfile')
      .leftJoinAndSelect('v.reviewedBy', 'reviewedBy')
      .orderBy('v.createdAt', 'DESC');

    if (query.status) {
      qb.andWhere('v.status = :status', { status: query.status });
    }

    const [records, total] = await qb
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return {
      message: 'Verifications retrieved.',
      data:    plainToInstance(VerificationResponseDto, records, { excludeExtraneousValues: true }),
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(id: number) {
    const verification = await this.repo.findOne({
      where: { id },
      relations: ['artisanProfile', 'artisanProfile.user', 'reviewedBy'],
    });
    if (!verification) throw new NotFoundException('Verification record not found.');
    return {
      message: 'Verification record retrieved.',
      data: plainToInstance(VerificationResponseDto, verification, { excludeExtraneousValues: true }),
    };
  }

  async startReview(adminUserId: number, id: number) {
    const verification = await this.loadOrFail(id);
    if (verification.status !== VerificationStatus.PENDING) {
      throw new BadRequestException(`Cannot start review — current status is ${verification.status}.`);
    }
    verification.status     = VerificationStatus.UNDER_REVIEW;
    verification.reviewedBy = { id: adminUserId } as any;
    verification.reviewedById = adminUserId;
    await this.repo.save(verification);
    return { message: 'Review started. Status is now UNDER_REVIEW.' };
  }

  async approve(adminUserId: number, id: number, dto: ApproveVerificationDto) {
    const verification = await this.loadOrFail(id, ['artisanProfile', 'artisanProfile.user']);
    if (verification.status === VerificationStatus.APPROVED) {
      throw new BadRequestException('This submission is already approved.');
    }
    if (
      verification.status !== VerificationStatus.PENDING &&
      verification.status !== VerificationStatus.UNDER_REVIEW
    ) {
      throw new BadRequestException(`Cannot approve a submission with status ${verification.status}.`);
    }

    verification.status      = VerificationStatus.APPROVED;
    verification.reviewedById = adminUserId;
    verification.reviewedBy   = { id: adminUserId } as any;
    verification.reviewedAt   = new Date();
    if (dto.notes) verification.adminNotes = dto.notes;

    await this.repo.save(verification);

    // Mark the artisan profile as verified
    verification.artisanProfile.isVerified = true;
    await this.profileRepo.save(verification.artisanProfile);

    this.eventEmitter.emit(APP_EVENTS.ARTISAN_PROFILE_VERIFIED, {
      artisanUserId: verification.artisanProfile.user.id,
    } as ArtisanProfileVerifiedPayload);

    return { message: 'Verification approved. Artisan profile is now verified.' };
  }

  async reject(adminUserId: number, id: number, dto: RejectVerificationDto) {
    const verification = await this.loadOrFail(id, ['artisanProfile', 'artisanProfile.user']);
    if (verification.status === VerificationStatus.REJECTED) {
      throw new BadRequestException('This submission is already rejected.');
    }
    if (verification.status === VerificationStatus.APPROVED) {
      throw new BadRequestException('Cannot reject an already approved submission.');
    }

    verification.status          = VerificationStatus.REJECTED;
    verification.rejectionReason = dto.reason;
    verification.reviewedById    = adminUserId;
    verification.reviewedBy      = { id: adminUserId } as any;
    verification.reviewedAt      = new Date();
    if (dto.notes) verification.adminNotes = dto.notes;

    await this.repo.save(verification);

    this.eventEmitter.emit(APP_EVENTS.ARTISAN_VERIFICATION_REJECTED, {
      artisanUserId: verification.artisanProfile.user.id,
      reason: dto.reason,
    } as ArtisanVerificationRejectedPayload);

    return { message: 'Verification rejected. Artisan has been notified.' };
  }

  private async loadOrFail(id: number, relations: string[] = []): Promise<ArtisanVerification> {
    const verification = await this.repo.findOne({ where: { id }, relations });
    if (!verification) throw new NotFoundException('Verification record not found.');
    return verification;
  }
}
