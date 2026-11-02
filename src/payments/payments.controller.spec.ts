import { Test, TestingModule } from '@nestjs/testing';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { CustomerPaymentHistoryService } from './customer-payment-history.service';
import { PaymentHistoryThrottlerGuard } from './payment-history-throttler.guard';
import {
  CustomerAnalyticsThrottlerGuard,
  CustomerExportThrottlerGuard,
} from '@common/throttling/customer-throttler.guards';
import { PaymentStatus, Role } from '@common/types/enums';
import type { AuthenticatedRequest } from '@common/types/authenticated-request.type';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ROLES_KEY } from '@common/decorators/roles.decorator';
import { ArtisanEarningsService } from './artisan-earnings.service';
import { BankListService } from './bank-list';
import {
  ArtisanExportThrottlerGuard,
  ArtisanInsightsThrottlerGuard,
  PayoutAccountLookupThrottlerGuard,
} from '@common/throttling/artisan-throttler.guards';
import { PayoutAccountService } from './payout-account.service';
import { SavedMethodChargeService } from './saved-method-charge.service';
import {
  PaymentChargeStatusThrottlerGuard,
  PaymentChargeThrottlerGuard,
} from '@common/throttling/customer-throttler.guards';
import { RejectPinFieldsGuard } from '@common/guards/reject-pin-fields.guard';

import type { CallHandler } from '@nestjs/common';
import { IdempotencyInterceptor } from '@common/idempotency/idempotency.interceptor';
import { INTERCEPTORS_METADATA } from '@nestjs/common/constants';

describe('PaymentsController', () => {
  let controller: PaymentsController;

  const service = {
    processWebhook: jest.fn(),
    initializePayment: jest.fn(),
    getMyHistory: jest.fn(),
    verifyPayment: jest.fn(),
    setupPayoutMethod: jest.fn(),
    retryPendingTransfer: jest.fn(),
    getMyEarnings: jest.fn(),
    getAllPayments: jest.fn(),
    getAdminSummary: jest.fn(),
    adminRefund: jest.fn(),
    setFraudFlag: jest.fn(),
    clearFraudFlag: jest.fn(),
    getJobPaymentState: jest.fn(),
  };

  const history = {
    getLegacyHistory: jest.fn(),
    getHistoryPage: jest.fn(),
    getFilterOptions: jest.fn(),
    streamExport: jest.fn(),
  };

  const earnings = {
    getStatement: jest.fn(),
    streamExport: jest.fn(),
  };

  const banks = { list: jest.fn() };
  const payoutAccounts = { resolve: jest.fn() };
  const savedCharges = {
    charge: jest.fn(),
    submitOtp: jest.fn(),
    status: jest.fn(),
  };

  const user = {
    id: 22,
    firstname: 'Ama',
    lastname: 'Owusu',
    email: 'ama@example.com',
  };
  const req = { user } as unknown as AuthenticatedRequest;
  const result = { message: 'ok' };

  beforeEach(async () => {
    jest.clearAllMocks();
    Object.values(service).forEach((fn) => fn.mockResolvedValue(result));
    Object.values(history).forEach((fn) => fn.mockResolvedValue(result));
    Object.values(earnings).forEach((fn) => fn.mockResolvedValue(result));
    banks.list.mockResolvedValue([{ code: '280100', name: 'Access Bank' }]);

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PaymentsController],
      providers: [
        { provide: PaymentsService, useValue: service },
        { provide: CustomerPaymentHistoryService, useValue: history },
        { provide: ArtisanEarningsService, useValue: earnings },
        { provide: BankListService, useValue: banks },
        { provide: PayoutAccountService, useValue: payoutAccounts },
        { provide: SavedMethodChargeService, useValue: savedCharges },
      ],
    })
      .overrideGuard(PaymentChargeThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PaymentChargeStatusThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PaymentHistoryThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(CustomerAnalyticsThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(CustomerExportThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(ArtisanInsightsThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(ArtisanExportThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PayoutAccountLookupThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideInterceptor(IdempotencyInterceptor)
      .useValue({
        intercept: (_c: unknown, next: CallHandler) => next.handle(),
      })
      .compile();

    controller = module.get(PaymentsController);
  });

  describe('webhook', () => {
    it('passes the raw body as a string and the signature header', async () => {
      const raw = Buffer.from('{"event":"charge.success"}');
      const webhookReq = { rawBody: raw } as Request & { rawBody?: Buffer };

      await expect(controller.webhook('sig_abc', webhookReq)).resolves.toBe(
        result,
      );
      expect(service.processWebhook).toHaveBeenCalledWith(
        '{"event":"charge.success"}',
        'sig_abc',
      );
    });

    it('falls back to empty strings when the body or signature is missing', async () => {
      await controller.webhook(
        undefined as unknown as string,
        {} as Request & { rawBody?: Buffer },
      );

      expect(service.processWebhook).toHaveBeenCalledWith('', '');
    });
  });

  it('initialize passes the customer id and the DTO job id', async () => {
    await expect(controller.initialize(req, { jobId: 35 })).resolves.toBe(
      result,
    );
    expect(service.initializePayment).toHaveBeenCalledWith(22, 35, {
      saveCard: undefined,
    });
  });

  describe('getHistory (B3)', () => {
    it('serves the legacy unpaginated list when there are no query parameters', async () => {
      const legacyReq = { user, query: {} } as unknown as AuthenticatedRequest;
      await expect(controller.getHistory(legacyReq, {})).resolves.toBe(result);
      expect(history.getLegacyHistory).toHaveBeenCalledWith(22);
      expect(history.getHistoryPage).not.toHaveBeenCalled();
    });

    it('serves the paginated form when any parameter is present', async () => {
      const pagedReq = {
        user,
        query: { page: '2' },
      } as unknown as AuthenticatedRequest;
      await controller.getHistory(pagedReq, { page: 2 });
      expect(history.getHistoryPage).toHaveBeenCalledWith(22, { page: 2 });
      expect(history.getLegacyHistory).not.toHaveBeenCalled();
    });
  });

  it("getHistoryFilters returns the caller's filter options (B3f)", async () => {
    await expect(controller.getHistoryFilters(req, {})).resolves.toBe(result);
    expect(history.getFilterOptions).toHaveBeenCalledWith(22);
  });

  it('exportHistory streams to the response with the caller id and request context (B10)', async () => {
    const res = {} as never;
    const exportReq = {
      user,
      ip: '198.51.100.4',
      headers: { 'user-agent': 'Test agent' },
    } as unknown as AuthenticatedRequest;
    await controller.exportHistory(exportReq, { range: '12m' }, res);
    expect(history.streamExport).toHaveBeenCalledWith(
      22,
      { range: '12m' },
      res,
      { ip: '198.51.100.4', userAgent: 'Test agent' },
    );
  });

  it.each([
    ['getHistory', PaymentHistoryThrottlerGuard],
    ['getHistoryFilters', CustomerAnalyticsThrottlerGuard],
    ['exportHistory', CustomerExportThrottlerGuard],
  ] as const)(
    'S-2 / T-6 %s has Jwt, Roles, its throttle and CUSTOMER',
    (name, throttle) => {
      const handler = PaymentsController.prototype[name];
      expect(Reflect.getMetadata('__guards__', handler)).toEqual([
        JwtAuthGuard,
        RolesGuard,
        throttle,
      ]);
      expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([Role.CUSTOMER]);
    },
  );

  it('verify passes the customer id and reference', async () => {
    await expect(controller.verify(req, 'jinva-35-22-111')).resolves.toBe(
      result,
    );
    expect(service.verifyPayment).toHaveBeenCalledWith(22, 'jinva-35-22-111');
  });

  it('setupPayout passes the artisan id and DTO', async () => {
    const dto = {
      type: 'mobile_money' as const,
      accountName: 'Kofi Mensah',
      accountNumber: '0240000000',
      bankCode: 'MTN',
    };

    await expect(controller.setupPayout(req, dto)).resolves.toBe(result);
    expect(service.setupPayoutMethod).toHaveBeenCalledWith(22, dto);
  });

  it('resolvePayoutAccount wraps the looked-up name', async () => {
    payoutAccounts.resolve.mockResolvedValue({ accountName: 'KOFI ASANTE' });
    const dto = {
      type: 'mobile_money' as const,
      accountNumber: '0240000000',
      bankCode: 'MTN',
    };

    await expect(controller.resolvePayoutAccount(dto)).resolves.toEqual({
      message: 'Account name found',
      data: { accountName: 'KOFI ASANTE' },
    });
    expect(payoutAccounts.resolve).toHaveBeenCalledWith(dto);
  });

  it.each(['resolvePayoutAccount', 'setupPayout'] as const)(
    '%s is artisan-only, lookup-throttled and never cached',
    (name) => {
      const handler = PaymentsController.prototype[name];
      expect(Reflect.getMetadata('__guards__', handler)).toEqual([
        JwtAuthGuard,
        RolesGuard,
        PayoutAccountLookupThrottlerGuard,
      ]);
      expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([Role.ARTISAN]);
      expect(Reflect.getMetadata('__headers__', handler)).toEqual([
        { name: 'Cache-Control', value: 'private, no-store' },
      ]);
    },
  );

  it('retryTransfer passes the artisan id and job id', async () => {
    await expect(controller.retryTransfer(req, 35)).resolves.toBe(result);
    expect(service.retryPendingTransfer).toHaveBeenCalledWith(22, 35);
  });

  it('getMyEarnings returns the artisan earnings', async () => {
    await expect(controller.getMyEarnings(req)).resolves.toBe(result);
    expect(service.getMyEarnings).toHaveBeenCalledWith(22);
  });

  describe('artisan earnings (B2) and banks (B6)', () => {
    it('getMyEarningsStatement passes the caller id and query', async () => {
      await expect(
        controller.getMyEarningsStatement(req, { period: '30d' }),
      ).resolves.toBe(result);
      expect(earnings.getStatement).toHaveBeenCalledWith(22, {
        period: '30d',
      });
    });

    it('exportMyEarnings streams with the caller id and request context', async () => {
      const res = {} as never;
      const exportReq = {
        user,
        ip: '198.51.100.9',
        headers: { 'user-agent': 'Agent' },
      } as unknown as AuthenticatedRequest;
      await controller.exportMyEarnings(exportReq, { period: 'all' }, res);
      expect(earnings.streamExport).toHaveBeenCalledWith(
        22,
        { period: 'all' },
        res,
        { ip: '198.51.100.9', userAgent: 'Agent' },
      );
    });

    it('listBanks wraps the cached list', async () => {
      await expect(controller.listBanks({})).resolves.toEqual({
        message: 'Banks retrieved',
        data: [{ code: '280100', name: 'Access Bank' }],
      });
    });

    it.each([
      ['getMyEarningsStatement', ArtisanInsightsThrottlerGuard],
      ['exportMyEarnings', ArtisanExportThrottlerGuard],
      ['listBanks', ArtisanInsightsThrottlerGuard],
    ] as const)('%s has Jwt, Roles, its throttle and ARTISAN', (name, t) => {
      const handler = PaymentsController.prototype[name];
      expect(Reflect.getMetadata('__guards__', handler)).toEqual([
        JwtAuthGuard,
        RolesGuard,
        t,
      ]);
      expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([Role.ARTISAN]);
    });
  });

  describe('adminList', () => {
    it('forwards paging and filters, truncating search to 100 characters', async () => {
      const longSearch = 'x'.repeat(150);

      await expect(
        controller.adminList(2, 50, longSearch, PaymentStatus.HELD),
      ).resolves.toBe(result);
      expect(service.getAllPayments).toHaveBeenCalledWith(2, 50, {
        search: 'x'.repeat(100),
        status: PaymentStatus.HELD,
      });
    });

    it('passes undefined filters through when none are given', async () => {
      await controller.adminList();

      expect(service.getAllPayments).toHaveBeenCalledWith(
        undefined,
        undefined,
        { search: undefined, status: undefined },
      );
    });
  });

  it('adminSummary returns the ledger totals', async () => {
    await expect(controller.adminSummary()).resolves.toBe(result);
    expect(service.getAdminSummary).toHaveBeenCalledWith();
  });

  it('adminRefund passes the payment id, amount and acting admin', async () => {
    await expect(
      controller.adminRefund(req, 7, { amountGhs: 20 }),
    ).resolves.toBe(result);
    expect(service.adminRefund).toHaveBeenCalledWith(7, 20, user);
  });

  it('flagPaymentForFraud passes the admin, payment id and reason', async () => {
    await expect(
      controller.flagPaymentForFraud(req, 7, {
        reason: 'Card reported stolen',
      }),
    ).resolves.toBe(result);
    expect(service.setFraudFlag).toHaveBeenCalledWith(
      user,
      7,
      'Card reported stolen',
    );
  });

  it('clearPaymentFraudFlag passes the admin, payment id and reason', async () => {
    await expect(
      controller.clearPaymentFraudFlag(req, 7, {
        reason: 'Verified with bank',
      }),
    ).resolves.toBe(result);
    expect(service.clearFraudFlag).toHaveBeenCalledWith(
      user,
      7,
      'Verified with bank',
    );
  });

  describe('saved payment methods', () => {
    const charge = {
      reference: 'jinva-ch-1',
      jobId: 35,
      method: 'mobile_money',
      status: 'pending',
      action: 'approve_on_phone',
      message: null,
    };
    beforeEach(() => {
      Object.values(savedCharges).forEach((fn) => fn.mockResolvedValue(charge));
    });

    it('charge passes the customer, job and method ids', async () => {
      await expect(
        controller.chargeSavedMethod(req, 35, { paymentMethodId: 4 }),
      ).resolves.toEqual({ message: 'Payment started', data: charge });
      expect(savedCharges.charge).toHaveBeenCalledWith(22, 35, 4);
    });

    it('submitChargeOtp passes the reference and code', async () => {
      await controller.submitChargeOtp(req, 'jinva-ch-1', { otp: '123456' });
      expect(savedCharges.submitOtp).toHaveBeenCalledWith(
        22,
        'jinva-ch-1',
        '123456',
      );
    });

    it('chargeStatus passes the customer and reference', async () => {
      const res = await controller.chargeStatus(req, 'jinva-ch-1');
      expect(res.data).toEqual(charge);
      expect(savedCharges.status).toHaveBeenCalledWith(22, 'jinva-ch-1');
    });

    it.each(['chargeSavedMethod', 'submitChargeOtp', 'initialize'] as const)(
      '%s refuses PIN fields and is customer-only',
      (handler) => {
        const guards = Reflect.getMetadata(
          '__guards__',
          PaymentsController.prototype[handler],
        ) as unknown[];
        expect(guards).toContain(RejectPinFieldsGuard);
        expect(
          Reflect.getMetadata('roles', PaymentsController.prototype[handler]),
        ).toEqual(['CUSTOMER']);
      },
    );

    it.each(['chargeSavedMethod', 'submitChargeOtp', 'initialize'] as const)(
      '%s takes an Idempotency-Key',
      (handler) => {
        expect(
          Reflect.getMetadata(
            INTERCEPTORS_METADATA,
            PaymentsController.prototype[handler],
          ),
        ).toContain(IdempotencyInterceptor);
      },
    );

    it('jobPaymentState passes the customer and job, is customer-only and never cached', async () => {
      const state = { jobId: 35, paid: false };
      service.getJobPaymentState.mockResolvedValue(state);
      await expect(controller.jobPaymentState(req, 35)).resolves.toEqual({
        message: 'Payment state retrieved',
        data: state,
      });
      expect(service.getJobPaymentState).toHaveBeenCalledWith(22, 35);
      const handler = PaymentsController.prototype.jobPaymentState;
      expect(Reflect.getMetadata('roles', handler)).toEqual(['CUSTOMER']);
      expect(Reflect.getMetadata('__guards__', handler) as unknown[]).toContain(
        PaymentChargeStatusThrottlerGuard,
      );
    });
  });
});
