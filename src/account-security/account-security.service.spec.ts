import type { Request } from 'express';
import type { EntityManager, Repository } from 'typeorm';
import {
  AccountSecurityService,
  SECURITY_EVENT_NAMES,
  SECURITY_EVENT_RETENTION_MONTHS,
  securityContextFrom,
} from './account-security.service';
import { AccountSecurityEvent } from './entities/account-security-event.entity';

function makeRepo() {
  return {
    insert: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue({ affected: 0 }),
  };
}

describe('AccountSecurityService', () => {
  let repo: ReturnType<typeof makeRepo>;
  let service: AccountSecurityService;

  beforeEach(() => {
    repo = makeRepo();
    service = new AccountSecurityService(
      repo as unknown as Repository<AccountSecurityEvent>,
    );
  });

  it('only knows the three event names the table accepts', () => {
    expect([...SECURITY_EVENT_NAMES].sort()).toEqual([
      'payment_settings.updated',
      'profile_photo.removed',
      'spending_report.exported',
    ]);
  });

  describe('record', () => {
    it('writes field names only, and truncates the user agent to 256', async () => {
      await service.record({
        userId: 5,
        event: 'payment_settings.updated',
        fieldsChanged: ['preferredChannel'],
        ip: '203.0.113.1',
        userAgent: 'x'.repeat(400),
      });
      const row = (repo.insert.mock.calls as unknown[][])[0][0] as Record<
        string,
        unknown
      >;
      expect(row).toEqual({
        userId: 5,
        event: 'payment_settings.updated',
        fieldsChanged: ['preferredChannel'],
        details: null,
        ip: '203.0.113.1',
        userAgent: 'x'.repeat(256),
      });
    });

    it('keeps only primitives and string arrays in details', async () => {
      await service.record({
        userId: 5,
        event: 'spending_report.exported',
        details: {
          range: '12m',
          statuses: ['HELD', 'RELEASED'],
          rowCount: 12,
          hasSearch: false,
          nothing: null,
          nested: { secret: 'x' } as unknown as string,
          mixed: ['a', 1] as unknown as string[],
          infinite: Number.POSITIVE_INFINITY,
        },
      });
      const row = (repo.insert.mock.calls as unknown[][])[0][0] as {
        details: unknown;
      };
      expect(row.details).toEqual({
        range: '12m',
        statuses: ['HELD', 'RELEASED'],
        rowCount: 12,
        hasSearch: false,
        nothing: null,
      });
    });

    it("uses the caller's transaction manager when given one, and throws on failure", async () => {
      const txRepo = makeRepo();
      txRepo.insert.mockRejectedValueOnce(new Error('boom'));
      const manager = {
        getRepository: jest.fn().mockReturnValue(txRepo),
      } as unknown as EntityManager;

      await expect(
        service.record({ userId: 1, event: 'profile_photo.removed' }, manager),
      ).rejects.toThrow('boom');
      expect(manager.getRepository).toHaveBeenCalledWith(AccountSecurityEvent);
      expect(repo.insert).not.toHaveBeenCalled();
    });

    it('stores an empty ip or user agent as null', async () => {
      await service.record({
        userId: 1,
        event: 'profile_photo.removed',
        ip: '',
        userAgent: null,
      });
      expect((repo.insert.mock.calls as unknown[][])[0][0]).toMatchObject({
        ip: null,
        userAgent: null,
        fieldsChanged: [],
      });
    });
  });

  describe('recordBestEffort', () => {
    it('never throws', async () => {
      repo.insert.mockRejectedValueOnce(new Error('db down'));
      await expect(
        service.recordBestEffort({ userId: 1, event: 'profile_photo.removed' }),
      ).resolves.toBeUndefined();
    });
  });

  describe('deleteForUser', () => {
    it("deletes only that user's events", async () => {
      const txRepo = makeRepo();
      const manager = {
        getRepository: jest.fn().mockReturnValue(txRepo),
      } as unknown as EntityManager;
      await service.deleteForUser(manager, 9);
      expect(txRepo.delete).toHaveBeenCalledWith({ userId: 9 });
    });
  });

  describe('retention', () => {
    it('cuts off at 12 months before now', () => {
      expect(SECURITY_EVENT_RETENTION_MONTHS).toBe(12);
      expect(
        AccountSecurityService.retentionCutoff(
          new Date('2026-10-30T12:00:00.000Z'),
        ).toISOString(),
      ).toBe('2025-10-30T12:00:00.000Z');
    });

    it('removes events older than the cut-off and reports how many', async () => {
      repo.delete.mockResolvedValueOnce({ affected: 3 });
      await expect(
        service.purgeExpiredEvents(new Date('2026-10-30T00:00:00.000Z')),
      ).resolves.toBe(3);
      const where = (repo.delete.mock.calls as unknown[][])[0][0] as {
        createdAt: { _value: Date };
      };
      expect(where.createdAt._value.toISOString()).toBe(
        '2025-10-30T00:00:00.000Z',
      );
    });

    it('never throws from the cron', async () => {
      repo.delete.mockRejectedValueOnce(new Error('db down'));
      await expect(service.purgeExpiredEvents()).resolves.toBe(0);
    });

    it('treats an unknown affected count as zero', async () => {
      repo.delete.mockResolvedValueOnce({});
      await expect(service.purgeExpiredEvents()).resolves.toBe(0);
    });
  });

  describe('securityContextFrom', () => {
    it('reads the ip and a truncated user agent', () => {
      const ctx = securityContextFrom({
        ip: '203.0.113.5',
        headers: { 'user-agent': 'a'.repeat(300) },
      } as unknown as Request);
      expect(ctx.ip).toBe('203.0.113.5');
      expect(ctx.userAgent).toHaveLength(256);
    });

    it('returns nulls when either is missing', () => {
      expect(
        securityContextFrom({ headers: {} } as unknown as Request),
      ).toEqual({ ip: null, userAgent: null });
    });
  });
});
