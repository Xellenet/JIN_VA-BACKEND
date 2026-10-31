import { Test } from '@nestjs/testing';
import { CustomerAnalyticsThrottlerGuard } from '@common/throttling/customer-throttler.guards';
import { ROLES_KEY } from '@common/decorators/roles.decorator';
import { Role } from '@common/types/enums';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AuthenticatedRequest } from '@common/types/authenticated-request.type';
import { CustomerOverviewController } from './customer-overview.controller';
import { CustomerOverviewService } from './customer-overview.service';
import { CustomerAnalyticsController } from './customer-analytics.controller';
import { CustomerAnalyticsService } from './customer-analytics.service';

describe('customer-insights controllers', () => {
  const overview = {
    getOverview: jest.fn().mockResolvedValue({ failedSections: [] }),
  };
  const analytics = {
    getSpending: jest.fn().mockResolvedValue({ range: '12m' }),
  };
  const req = { user: { id: 1042 } } as unknown as AuthenticatedRequest;
  let overviewCtrl: CustomerOverviewController;
  let analyticsCtrl: CustomerAnalyticsController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      controllers: [CustomerOverviewController, CustomerAnalyticsController],
      providers: [
        { provide: CustomerOverviewService, useValue: overview },
        { provide: CustomerAnalyticsService, useValue: analytics },
      ],
    })
      .overrideGuard(CustomerAnalyticsThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    overviewCtrl = module.get(CustomerOverviewController);
    analyticsCtrl = module.get(CustomerAnalyticsController);
  });

  it('B6 wraps the overview for the JWT subject', async () => {
    await expect(overviewCtrl.getOverview(req, {})).resolves.toEqual({
      message: 'Overview retrieved',
      data: { failedSections: [] },
    });
    expect(overview.getOverview).toHaveBeenCalledWith(1042);
  });

  it('B2 defaults the range to 12m and passes an explicit one through', async () => {
    await expect(analyticsCtrl.getSpending(req, {})).resolves.toEqual({
      message: 'Spending analytics retrieved',
      data: { range: '12m' },
    });
    expect(analytics.getSpending).toHaveBeenCalledWith(1042, '12m');
    await analyticsCtrl.getSpending(req, { range: '30d' });
    expect(analytics.getSpending).toHaveBeenLastCalledWith(1042, '30d');
  });

  it.each([
    [CustomerOverviewController.prototype.getOverview],
    [CustomerAnalyticsController.prototype.getSpending],
  ])(
    'S-2 / T-6 route has Jwt, Roles, the analytics throttle and CUSTOMER',
    (handler) => {
      expect(Reflect.getMetadata('__guards__', handler)).toEqual([
        JwtAuthGuard,
        RolesGuard,
        CustomerAnalyticsThrottlerGuard,
      ]);
      expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([Role.CUSTOMER]);
    },
  );
});
