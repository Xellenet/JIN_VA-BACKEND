import { Body, Controller, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { ArtisansService } from './artisans.service';
import { CreateArtisanDto } from './dto/create-artisan.dto';
import { CreateArtisanPortfolioImageDto } from './dto/create-artisan-portfolio-image.dto';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Artisan } from './entities/artisan.entity';

@ApiTags('Artisans')
@Controller('artisans')
export class ArtisansController {
  constructor(private readonly artisansService: ArtisansService) {}

  @Post()
  @ApiCreatedResponse({ description: 'Artisan profile created successfully.', type: Artisan })
  create(@Body() createArtisanDto: CreateArtisanDto) {
    return this.artisansService.create(createArtisanDto);
  }

  @Get()
  @ApiOkResponse({ description: 'Returns all artisan profiles.', type: [Artisan] })
  findAll() {
    return this.artisansService.findAll();
  }

  @Get(':id')
  @ApiOkResponse({ description: 'Returns a single artisan profile.', type: Artisan })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.artisansService.findOne(id);
  }

  @Post(':id/portfolio-images')
  @ApiCreatedResponse({ description: 'Portfolio image added to artisan.', type: Artisan })
  addPortfolioImage(
    @Param('id', ParseIntPipe) id: number,
    @Body() createArtisanPortfolioImageDto: CreateArtisanPortfolioImageDto,
  ) {
    return this.artisansService.addPortfolioImage(id, createArtisanPortfolioImageDto);
  }

  @Post(':id/services')
  @ApiOkResponse({ description: 'Services mapped to artisan.', type: Artisan })
  mapServices(
    @Param('id', ParseIntPipe) id: number,
    @Body('serviceIds') serviceIds: number[],
  ) {
    return this.artisansService.mapServices(id, serviceIds || []);
  }
}
