import { PartialType } from '@nestjs/mapped-types';
import { CreateArtisanProfileDto } from './create-artisan-profile.dto';

export class UpdateArtisanProfileDto extends PartialType(CreateArtisanProfileDto) {}
