import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ThrottlingModule } from '@common/throttling/throttling.module';
import { LocationsController } from './locations.controller';
import { LocationsService } from './locations.service';
import { LocationSuggestionsThrottlerGuard } from './guards/location-suggestions-throttler.guard';

/**
 * LOC10: `GET /locations/suggestions`, the backend proxy for the artisan
 * "Town or area" field. Its own `HttpModule` instance, so no default headers
 * or interceptors from another module's client can reach the upstream call.
 */
@Module({
  imports: [HttpModule, ThrottlingModule],
  controllers: [LocationsController],
  providers: [LocationsService, LocationSuggestionsThrottlerGuard],
})
export class LocationsModule {}
