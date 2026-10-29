import { Test, TestingModule } from '@nestjs/testing';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PaymentStatus } from '@common/types/enums';
import type { AuthenticatedRequest } from '@common/types/authenticated-request.type';
import type { Request } from 'express';

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

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PaymentsController],
      providers: [{ provide: PaymentsService, useValue: service }],
    }).compile();

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
    expect(service.initializePayment).toHaveBeenCalledWith(22, 35);
  });

  it('getHistory returns the customer history', async () => {
    await expect(controller.getHistory(req)).resolves.toBe(result);
    expect(service.getMyHistory).toHaveBeenCalledWith(22);
  });

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

  it('retryTransfer passes the artisan id and job id', async () => {
    await expect(controller.retryTransfer(req, 35)).resolves.toBe(result);
    expect(service.retryPendingTransfer).toHaveBeenCalledWith(22, 35);
  });

  it('getMyEarnings returns the artisan earnings', async () => {
    await expect(controller.getMyEarnings(req)).resolves.toBe(result);
    expect(service.getMyEarnings).toHaveBeenCalledWith(22);
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
});
