import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import { ArtisanPublicResponseDto } from '@artisans/dto/artisan-public-response.dto';

/**
 * `GET /favourites` response shape — the standard public artisan shape plus
 * `favouritedAt` (the `Favourite` join row's own `createdAt`, not the
 * artisan profile's). `completedJobsCount` is inherited from
 * `ArtisanPublicResponseDto` and populated the same way `ArtisansService`
 * already does for search/profile (`FavouritesService.findAll`).
 */
export class FavouriteArtisanResponseDto extends ArtisanPublicResponseDto {
  @ApiProperty({
    description: 'When this artisan was added to the favourites list.',
  })
  @Expose()
  favouritedAt: Date;
}
