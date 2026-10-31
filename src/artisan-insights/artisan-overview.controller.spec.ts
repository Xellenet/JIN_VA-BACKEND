import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ROLES_KEY } from '@common/decorators/roles.decorator';
import { Role } from '@common/types/enums';
import { ArtisanInsightsThrottlerGuard } from '@common/throttling/artisan-throttler.guards';
import type { AuthenticatedRequest } from '@common/types/authenticated-request.type';
import { ArtisanOverviewController } from './artisan-overview.controller';

describe('ArtisanOverviewController (B1)', () => {
  it('returns the overview for the JWT subject', async () => {
    const overview = { getOverview: jest.fn().mockResolvedValue({ a: 1 }) };
    const controller = new ArtisanOverviewController(overview as never);
    await expect(
      controller.getOverview(
        { user: { id: 5 } } as unknown as AuthenticatedRequest,
        {},
      ),
    ).resolves.toEqual({ message: 'Overview retrieved', data: { a: 1 } });
    expect(overview.getOverview).toHaveBeenCalledWith(5);
  });

  it('has Jwt, Roles, the artisan-insights throttle, ARTISAN and no-store', () => {
    const handler = ArtisanOverviewController.prototype.getOverview;
    expect(Reflect.getMetadata('__guards__', handler)).toEqual([
      JwtAuthGuard,
      RolesGuard,
      ArtisanInsightsThrottlerGuard,
    ]);
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([Role.ARTISAN]);
    expect(Reflect.getMetadata('__headers__', handler)).toEqual([
      { name: 'Cache-Control', value: 'private, no-store' },
    ]);
  });
});
