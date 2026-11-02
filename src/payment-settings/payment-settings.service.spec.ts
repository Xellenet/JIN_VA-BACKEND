import { NotFoundException } from '@nestjs/common';
import type { DataSource, EntityManager, Repository } from 'typeorm';
import type { User } from '@users/entities/user.entity';
import type { AccountSecurityService } from '../account-security/account-security.service';
import { PaymentSettingsService } from './payment-settings.service';
import { CustomerPaymentSettings } from './entities/customer-payment-settings.entity';

const CONTEXT = { ip: '203.0.113.2', userAgent: 'jest' };
const OWNER = { id: 11, email: 'ama.owusu@example.com', isSuspended: false };

function setup(
  existing: Partial<CustomerPaymentSettings> | null = null,
  owner: Partial<User> | null = OWNER,
) {
  const settingsRepo = {
    findOne: jest.fn().mockResolvedValue(existing),
  };
  const userRepo = { findOne: jest.fn().mockResolvedValue(owner) };
  const txRepo = {
    findOne: jest.fn().mockResolvedValue(existing ? { ...existing } : null),
    create: jest.fn((v: Partial<CustomerPaymentSettings>) => ({ ...v })),
    save: jest.fn((v: Partial<CustomerPaymentSettings>) =>
      Promise.resolve({
        ...v,
        updatedAt: new Date('2026-10-30T08:15:00.000Z'),
      }),
    ),
    delete: jest.fn(),
  };
  const manager = {
    getRepository: jest.fn().mockReturnValue(txRepo),
  } as unknown as EntityManager;
  const dataSource = {
    transaction: jest.fn((fn: (m: EntityManager) => Promise<unknown>) =>
      fn(manager),
    ),
  } as unknown as DataSource;
  const accountSecurity = {
    record: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<AccountSecurityService>;
  const service = new PaymentSettingsService(
    settingsRepo as unknown as Repository<CustomerPaymentSettings>,
    userRepo as unknown as Repository<User>,
    dataSource,
    accountSecurity,
  );
  return {
    service,
    settingsRepo,
    userRepo,
    txRepo,
    manager,
    dataSource,
    accountSecurity,
  };
}

describe('PaymentSettingsService', () => {
  describe('getSettings', () => {
    it('BU-5.4: with no row, returns defaults and the account email, and writes nothing', async () => {
      const { service, txRepo, dataSource } = setup(null);
      const result = await service.getSettings(11);
      expect(result).toEqual({
        message: 'Payment settings retrieved',
        data: {
          preferredChannel: null,
          momoNetwork: null,
          receiptEmail: 'ama.owusu@example.com',
          updatedAt: null,
          editable: true,
        },
      });
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(txRepo.save).not.toHaveBeenCalled();
    });

    it('returns the saved values and is not editable while suspended', async () => {
      const { service, settingsRepo } = setup(
        {
          userId: 11,
          preferredChannel: 'mobile_money',
          momoNetwork: 'MTN',
          updatedAt: new Date('2026-10-01T10:00:00.000Z'),
        },
        { ...OWNER, isSuspended: true },
      );
      const { data } = await service.getSettings(11);
      expect(settingsRepo.findOne).toHaveBeenCalledWith({
        where: { userId: 11 },
      });
      expect(data).toEqual({
        preferredChannel: 'mobile_money',
        momoNetwork: 'MTN',
        receiptEmail: 'ama.owusu@example.com',
        updatedAt: '2026-10-01T10:00:00.000Z',
        editable: false,
      });
    });

    it('404s when the account no longer exists', async () => {
      const { service } = setup(null, null);
      await expect(service.getSettings(11)).rejects.toThrow(NotFoundException);
    });
  });

  describe('changedFields', () => {
    it('lists only fields that really change, in a fixed order', () => {
      const current = { preferredChannel: 'card', momoNetwork: null } as const;
      expect(
        PaymentSettingsService.changedFields(current, {
          momoNetwork: 'AT',
          preferredChannel: 'card',
        }),
      ).toEqual(['momoNetwork']);
      expect(PaymentSettingsService.changedFields(current, {})).toEqual([]);
      expect(
        PaymentSettingsService.changedFields(null, { preferredChannel: null }),
      ).toEqual([]);
      expect(
        PaymentSettingsService.changedFields(null, {
          preferredChannel: 'mobile_money',
          momoNetwork: 'TELECEL',
        }),
      ).toEqual(['preferredChannel', 'momoNetwork']);
    });
  });

  describe('updateSettings', () => {
    it('an empty body is a no-op: no write and no event', async () => {
      const { service, txRepo, accountSecurity } = setup(null);
      const result = await service.updateSettings(11, {}, CONTEXT);
      expect(txRepo.save).not.toHaveBeenCalled();
      expect(accountSecurity.record).not.toHaveBeenCalled();
      expect(result.message).toBe('Payment preferences saved');
      expect(result.data.preferredChannel).toBeNull();
    });

    it('the same values again are a no-op', async () => {
      const { service, txRepo, accountSecurity } = setup({
        userId: 11,
        preferredChannel: 'card',
        momoNetwork: 'MTN',
      });
      await service.updateSettings(
        11,
        { preferredChannel: 'card', momoNetwork: 'MTN' },
        CONTEXT,
      );
      expect(txRepo.save).not.toHaveBeenCalled();
      expect(accountSecurity.record).not.toHaveBeenCalled();
    });

    it('BU-5.5: creates the row and records the event with field names only, in the same transaction', async () => {
      const { service, txRepo, accountSecurity, manager } = setup(null);
      const result = await service.updateSettings(
        11,
        { preferredChannel: 'mobile_money' },
        CONTEXT,
      );
      expect(txRepo.findOne).toHaveBeenCalledWith({
        where: { userId: 11 },
        lock: { mode: 'pessimistic_write' },
      });
      expect(txRepo.save).toHaveBeenCalledWith({
        userId: 11,
        preferredChannel: 'mobile_money',
        momoNetwork: null,
      });
      expect(accountSecurity.record).toHaveBeenCalledWith(
        {
          userId: 11,
          event: 'payment_settings.updated',
          fieldsChanged: ['preferredChannel'],
          ip: '203.0.113.2',
          userAgent: 'jest',
        },
        manager,
      );
      const recorded = JSON.stringify(accountSecurity.record.mock.calls[0][0]);
      expect(recorded).not.toContain('mobile_money');
      expect(result.data).toEqual({
        preferredChannel: 'mobile_money',
        momoNetwork: null,
        receiptEmail: 'ama.owusu@example.com',
        updatedAt: '2026-10-30T08:15:00.000Z',
        editable: true,
      });
    });

    it('null clears a saved value', async () => {
      const { service, txRepo, accountSecurity } = setup({
        id: 3,
        userId: 11,
        preferredChannel: 'card',
        momoNetwork: 'MTN',
      });
      await service.updateSettings(11, { momoNetwork: null }, CONTEXT);
      expect(txRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 3,
          preferredChannel: 'card',
          momoNetwork: null,
        }),
      );
      expect(accountSecurity.record.mock.calls[0][0].fieldsChanged).toEqual([
        'momoNetwork',
      ]);
    });

    it('a failed event write fails the whole change (rolled back with the transaction)', async () => {
      const { service, accountSecurity } = setup(null);
      accountSecurity.record.mockRejectedValueOnce(new Error('insert failed'));
      await expect(
        service.updateSettings(11, { preferredChannel: 'card' }, CONTEXT),
      ).rejects.toThrow('insert failed');
    });
  });

  describe('deleteForUser', () => {
    it("deletes only that user's row", async () => {
      const { service, txRepo, manager } = setup(null);
      await service.deleteForUser(manager, 11);
      expect(manager.getRepository).toHaveBeenCalledWith(
        CustomerPaymentSettings,
      );
      expect(txRepo.delete).toHaveBeenCalledWith({ userId: 11 });
    });
  });
});
