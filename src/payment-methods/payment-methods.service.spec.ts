import {
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import type { DataSource, Repository } from 'typeorm';
import { PaymentDataEncryptionService } from '@common/crypto/payment-data-encryption.service';
import type { AccountSecurityService } from '../account-security/account-security.service';
import type { PaystackService } from '../payments/paystack.service';
import { User } from '@users/entities/user.entity';
import { CustomerPaymentMethod } from './entities/customer-payment-method.entity';
import {
  METHOD_ALREADY_SAVED,
  METHOD_LIMIT_REACHED,
  PaymentMethodsService,
} from './payment-methods.service';

/** All values fictional. */
const NUMBER = '0240000000';
const ctx = { ip: '127.0.0.1', userAgent: 'jest' };

function encryption(enabled = true) {
  const cfg = {
    get: (k: string) =>
      enabled && k === 'PAYMENT_DATA_ENCRYPTION_KEY'
        ? randomBytes(32).toString('base64')
        : undefined,
  } as unknown as ConfigService;
  return new PaymentDataEncryptionService(cfg);
}

/** An in-memory stand-in for the methods table, enough for the service. */
function memoryRepo(rows: CustomerPaymentMethod[]) {
  let nextId = 100;
  const match = (r: CustomerPaymentMethod, where: Record<string, unknown>) =>
    Object.entries(where).every(
      ([k, v]) => (r as unknown as Record<string, unknown>)[k] === v,
    );
  return {
    rows,
    find: jest.fn(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(
        rows
          .filter((r) => match(r, where))
          .sort(
            (a, b) =>
              Number(b.isDefault) - Number(a.isDefault) ||
              b.createdAt.getTime() - a.createdAt.getTime(),
          ),
      ),
    ),
    findOne: jest.fn(
      ({
        where,
        order,
      }: {
        where: Record<string, unknown>;
        order?: unknown;
      }) => {
        const found = rows.filter((r) => match(r, where));
        if (order)
          found.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return Promise.resolve(found[0] ?? null);
      },
    ),
    create: jest.fn((v: Partial<CustomerPaymentMethod>) => v),
    save: jest.fn((v: CustomerPaymentMethod) => {
      const row = {
        ...v,
        id: nextId++,
        createdAt: new Date(Date.now() + nextId),
        updatedAt: new Date(),
      } as CustomerPaymentMethod;
      rows.push(row);
      return Promise.resolve(row);
    }),
    update: jest.fn(
      (
        where: Record<string, unknown>,
        patch: Partial<CustomerPaymentMethod>,
      ) => {
        rows
          .filter((r) => match(r, where))
          .forEach((r) => Object.assign(r, patch));
        return Promise.resolve();
      },
    ),
    delete: jest.fn((where: Record<string, unknown>) => {
      for (let i = rows.length - 1; i >= 0; i--) {
        if (match(rows[i], where)) rows.splice(i, 1);
      }
      return Promise.resolve();
    }),
  };
}

describe('PaymentMethodsService', () => {
  let repo: ReturnType<typeof memoryRepo>;
  let enc: PaymentDataEncryptionService;
  const userRepo = { findOne: jest.fn() };
  const paystack = { resolveAccount: jest.fn() };
  const security = { record: jest.fn() };
  let service: PaymentMethodsService;

  const build = (enabled = true) => {
    enc = encryption(enabled);
    const manager = {
      getRepository: (e: unknown) => (e === User ? userRepo : repo),
    };
    const dataSource = {
      transaction: (cb: (m: typeof manager) => unknown) => cb(manager),
    } as unknown as DataSource;
    service = new PaymentMethodsService(
      repo as unknown as Repository<CustomerPaymentMethod>,
      dataSource,
      enc,
      paystack as unknown as PaystackService,
      security as unknown as AccountSecurityService,
    );
  };

  beforeEach(() => {
    jest.clearAllMocks();
    repo = memoryRepo([]);
    userRepo.findOne.mockResolvedValue({ id: 1 });
    paystack.resolveAccount.mockResolvedValue({
      status: 'resolved',
      accountName: 'KOFI ASANTE',
    });
    security.record.mockResolvedValue(undefined);
    build();
  });

  const addMomo = (userId = 1, accountNumber = NUMBER, network = 'MTN') =>
    service.addMobileMoney(
      userId,
      { accountNumber, network: network as 'MTN' },
      ctx,
    );

  it('saves a number with the looked-up name, encrypted, masked in the reply, first one default', async () => {
    const dto = await addMomo();
    expect(dto).toMatchObject({
      type: 'mobile_money',
      isDefault: true,
      mobileMoney: {
        network: 'MTN',
        numberMasked: '024 ••• 0000',
        last4: '0000',
        accountName: 'KOFI ASANTE',
        nameVerified: true,
      },
      card: null,
    });
    expect(JSON.stringify(dto)).not.toContain(NUMBER);
    const row = repo.rows[0];
    expect(row.numberEncrypted).toMatch(/^v1:/);
    expect(row.numberEncrypted).not.toContain(NUMBER);
    expect(enc.decrypt(row.numberEncrypted!)).toBe(NUMBER);
    expect(row.numberHash).toBe(enc.hash(NUMBER));
    expect(security.record).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'payment_method.added',
        details: { type: 'mobile_money', network: 'MTN' },
      }),
      expect.anything(),
    );
    expect(JSON.stringify(security.record.mock.calls)).not.toContain(NUMBER);
  });

  it('a second number is not the default; the same number twice is 409 with no lookup', async () => {
    await addMomo();
    const second = await addMomo(1, '0550000000');
    expect(second.isDefault).toBe(false);
    paystack.resolveAccount.mockClear();
    await expect(addMomo()).rejects.toThrow(METHOD_ALREADY_SAVED);
    expect(paystack.resolveAccount).not.toHaveBeenCalled();
  });

  it('refuses a sixth method with 409', async () => {
    for (let i = 0; i < 5; i++) await addMomo(1, `024000000${i}`);
    await expect(addMomo(1, '0540000000')).rejects.toThrow(
      METHOD_LIMIT_REACHED,
    );
  });

  it('maps lookup outcomes: not found → 422, unavailable → 503, nothing saved', async () => {
    paystack.resolveAccount.mockResolvedValueOnce({ status: 'unresolvable' });
    await expect(addMomo()).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    paystack.resolveAccount.mockResolvedValueOnce({ status: 'unavailable' });
    await expect(addMomo()).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(repo.rows).toHaveLength(0);
  });

  it('answers 503 for saving and charging when there is no key, but still lists', async () => {
    build(false);
    await expect(addMomo()).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(service.getChargeable(1, 1)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(service.list(1)).resolves.toMatchObject({
      methods: [],
      canSave: false,
      maxMethods: 5,
    });
    expect(await service.saveCardFromAuthorization(1, { reusable: true })).toBe(
      'disabled',
    );
  });

  it('setDefault and remove enforce ownership with 404', async () => {
    const mine = await addMomo(1);
    await expect(service.setDefault(2, mine.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.remove(2, mine.id, ctx)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(repo.rows).toHaveLength(1);
  });

  it('setDefault moves the single default; removing the default promotes the newest', async () => {
    const a = await addMomo(1, '0240000001');
    const b = await addMomo(1, '0240000002');
    const c = await addMomo(1, '0240000003');
    let list = await service.setDefault(1, b.id);
    expect(list.methods.filter((m) => m.isDefault).map((m) => m.id)).toEqual([
      b.id,
    ]);
    list = await service.setDefault(1, b.id); // already default: no-op
    expect(list.methods[0].id).toBe(b.id);
    list = await service.remove(1, b.id, ctx);
    expect(list.methods.map((m) => m.id).sort()).toEqual([a.id, c.id].sort());
    expect(list.methods.find((m) => m.isDefault)?.id).toBe(c.id);
    expect(security.record).toHaveBeenLastCalledWith(
      expect.objectContaining({
        event: 'payment_method.removed',
        details: { type: 'mobile_money' },
      }),
      expect.anything(),
    );
  });

  describe('saveCardFromAuthorization', () => {
    const auth = (over: Record<string, unknown> = {}) => ({
      authorization_code: 'AUTH_fict1onal',
      card_type: 'visa ',
      last4: '4081',
      exp_month: '12',
      exp_year: '2030',
      bank: 'TEST BANK',
      channel: 'card',
      signature: 'SIG_fictional',
      reusable: true,
      ...over,
    });

    it('saves a reusable card: encrypted code, hashed signature, labels only', async () => {
      expect(await service.saveCardFromAuthorization(1, auth())).toBe('saved');
      const row = repo.rows[0];
      expect(row).toMatchObject({
        type: 'card',
        isDefault: true,
        cardBrand: 'visa',
        cardLast4: '4081',
        expMonth: 12,
        expYear: 2030,
        cardBank: 'TEST BANK',
      });
      expect(enc.decrypt(row.authorizationEncrypted!)).toBe('AUTH_fict1onal');
      expect(row.signatureHash).toBe(enc.hash('SIG_fictional'));
      expect(JSON.stringify(row)).not.toContain('SIG_fictional');
      const list = await service.list(1);
      expect(list.methods[0].card).toMatchObject({
        brand: 'visa',
        last4: '4081',
        expired: false,
      });
      expect(JSON.stringify(list)).not.toContain('AUTH_');
    });

    it('does not save the same card twice', async () => {
      await service.saveCardFromAuthorization(1, auth());
      expect(await service.saveCardFromAuthorization(1, auth())).toBe(
        'duplicate',
      );
      expect(repo.rows).toHaveLength(1);
    });

    it.each([
      ['not reusable', { reusable: false }, 'not_reusable'],
      ['not a card', { channel: 'mobile_money' }, 'not_reusable'],
      ['a bad code', { authorization_code: 'x' }, 'invalid'],
      ['no signature', { signature: '' }, 'invalid'],
      ['a bad month', { exp_month: '13' }, 'invalid'],
    ])('skips %s', async (_l, over, outcome) => {
      expect(await service.saveCardFromAuthorization(1, auth(over))).toBe(
        outcome,
      );
      expect(repo.rows).toHaveLength(0);
    });

    it('skips when the customer already has five methods', async () => {
      for (let i = 0; i < 5; i++) await addMomo(1, `024000000${i}`);
      expect(await service.saveCardFromAuthorization(1, auth())).toBe('limit');
      expect(await service.saveCardFromAuthorization(1, null)).toBe(
        'not_reusable',
      );
    });

    it('never saves a card for a closed (soft-deleted) account', async () => {
      userRepo.findOne.mockResolvedValueOnce(null);
      expect(await service.saveCardFromAuthorization(1, auth())).toBe(
        'account_closed',
      );
      expect(repo.rows).toHaveLength(0);
    });
  });

  it('getChargeable decrypts only the caller’s method', async () => {
    const m = await addMomo(1);
    await service.saveCardFromAuthorization(1, {
      authorization_code: 'AUTH_fict1onal',
      last4: '4081',
      exp_month: 1,
      exp_year: 2020,
      channel: 'card',
      signature: 'SIG_2',
      reusable: true,
    });
    await expect(service.getChargeable(1, m.id)).resolves.toEqual({
      id: m.id,
      type: 'mobile_money',
      network: 'MTN',
      phone: NUMBER,
    });
    const card = repo.rows.find((r) => r.type === 'card')!;
    await expect(service.getChargeable(1, card.id)).resolves.toMatchObject({
      type: 'card',
      authorizationCode: 'AUTH_fict1onal',
      expired: true,
    });
    await expect(service.getChargeable(2, m.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('resolve wraps the name or maps the outcome', async () => {
    await expect(
      service.resolve({ network: 'VOD', accountNumber: '0200000000' }),
    ).resolves.toEqual({ accountName: 'KOFI ASANTE' });
    expect(paystack.resolveAccount).toHaveBeenCalledWith('0200000000', 'VOD');
  });

  it('a missing owner is 404', async () => {
    userRepo.findOne.mockResolvedValue(null);
    await expect(addMomo()).rejects.toBeInstanceOf(NotFoundException);
    await expect(addMomo()).rejects.not.toBeInstanceOf(ConflictException);
  });
});
