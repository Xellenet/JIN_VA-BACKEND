import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Artisan } from './entities/artisan.entity';
import { ArtisanPortfolioImage } from './entities/artisan-portfolio-image.entity';
import { CreateArtisanDto } from './dto/create-artisan.dto';
import { CreateArtisanPortfolioImageDto } from './dto/create-artisan-portfolio-image.dto';
import { User } from '@users/entities/user.entity';
import { Address } from '@users/entities/address.entity';
import { Role } from '@common/types/enums';
import { ServiceEntity } from '../services/entities/service.entity';

@Injectable()
export class ArtisansService {
  private readonly logger = new Logger(ArtisansService.name);

  constructor(
    @InjectRepository(Artisan)
    private readonly artisansRepository: Repository<Artisan>,
    @InjectRepository(ArtisanPortfolioImage)
    private readonly artisanPortfolioImagesRepository: Repository<ArtisanPortfolioImage>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(Address)
    private readonly addressesRepository: Repository<Address>,
    @InjectRepository(ServiceEntity)
    private readonly servicesRepository: Repository<ServiceEntity>,
  ) {}

  async create(createArtisanDto: CreateArtisanDto): Promise<Artisan> {
    const existingProfile = await this.artisansRepository.findOne({
      where: { user: { id: createArtisanDto.userId } },
      relations: ['user'],
    });

    if (existingProfile) {
      throw new BadRequestException('Artisan profile already exists for this user.');
    }

    const user = await this.usersRepository.findOne({
      where: { id: createArtisanDto.userId },
    });

    if (!user) {
      throw new NotFoundException(`User with id ${createArtisanDto.userId} not found.`);
    }

    let locationAddress: Address | undefined;
    if (createArtisanDto.locationAddressId) {
      const foundAddress = await this.addressesRepository.findOne({
        where: { id: createArtisanDto.locationAddressId },
      });

      if (!foundAddress) {
        throw new NotFoundException(
          `Address with id ${createArtisanDto.locationAddressId} not found.`,
        );
      }

      locationAddress = foundAddress;
    }

    let mappedServices: ServiceEntity[] = [];
    if (createArtisanDto.serviceIds?.length) {
      mappedServices = await this.servicesRepository.findBy({
        id: In(createArtisanDto.serviceIds),
      });

      if (mappedServices.length !== createArtisanDto.serviceIds.length) {
        throw new NotFoundException('One or more services were not found.');
      }
    }

    const artisan = this.artisansRepository.create({
      user,
      contactPhone: createArtisanDto.contactPhone,
      contactEmail: createArtisanDto.contactEmail,
      locationAddress,
      bio: createArtisanDto.bio,
      yearsOfExperience: createArtisanDto.yearsOfExperience,
      certifications: createArtisanDto.certifications,
      licenseNumber: createArtisanDto.licenseNumber,
      specializations: createArtisanDto.specializations,
      services: mappedServices,
    });

    const savedArtisan = await this.artisansRepository.save(artisan);

    if (createArtisanDto.portfolioImages?.length) {
      const images = createArtisanDto.portfolioImages.map((image) =>
        this.artisanPortfolioImagesRepository.create({
          artisan: savedArtisan,
          imageUrl: image.imageUrl,
          caption: image.caption,
          displayOrder: image.displayOrder ?? 0,
        }),
      );
      await this.artisanPortfolioImagesRepository.save(images);
    }

    if (user.role !== Role.ARTISAN) {
      user.role = Role.ARTISAN;
      await this.usersRepository.save(user);
    }

    this.logger.log(`Created artisan profile for user id: ${user.id}`);
    return this.findOne(savedArtisan.id);
  }

  async findAll(): Promise<Artisan[]> {
    return this.artisansRepository.find({
      relations: ['user', 'locationAddress', 'portfolioImages', 'services'],
      order: {
        id: 'DESC',
      },
    });
  }

  async findOne(id: number): Promise<Artisan> {
    const artisan = await this.artisansRepository.findOne({
      where: { id },
      relations: ['user', 'locationAddress', 'portfolioImages', 'services'],
    });

    if (!artisan) {
      throw new NotFoundException(`Artisan with id ${id} not found.`);
    }

    return artisan;
  }

  async addPortfolioImage(
    artisanId: number,
    createArtisanPortfolioImageDto: CreateArtisanPortfolioImageDto,
  ): Promise<Artisan> {
    const artisan = await this.findOne(artisanId);

    const image = this.artisanPortfolioImagesRepository.create({
      artisan,
      imageUrl: createArtisanPortfolioImageDto.imageUrl,
      caption: createArtisanPortfolioImageDto.caption,
      displayOrder: createArtisanPortfolioImageDto.displayOrder ?? 0,
    });

    await this.artisanPortfolioImagesRepository.save(image);
    this.logger.log(`Added portfolio image for artisan id: ${artisanId}`);

    return this.findOne(artisanId);
  }

  async mapServices(artisanId: number, serviceIds: number[]): Promise<Artisan> {
    const artisan = await this.artisansRepository.findOne({
      where: { id: artisanId },
      relations: ['services'],
    });

    if (!artisan) {
      throw new NotFoundException(`Artisan with id ${artisanId} not found.`);
    }

    if (!serviceIds.length) {
      artisan.services = [];
      await this.artisansRepository.save(artisan);
      return this.findOne(artisanId);
    }

    const services = await this.servicesRepository.findBy({
      id: In(serviceIds),
    });

    if (services.length !== serviceIds.length) {
      throw new NotFoundException('One or more services were not found.');
    }

    artisan.services = services;
    await this.artisansRepository.save(artisan);

    this.logger.log(`Mapped ${serviceIds.length} services to artisan id: ${artisanId}`);
    return this.findOne(artisanId);
  }
}
