import {
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { User } from '@users/entities/user.entity';
import { AccountSecurityService } from '../account-security/account-security.service';
import { PaymentDataEncryptionService } from '@common/crypto/payment-data-encryption.service';
import { PaystackService } from '../payments/paystack.service';
import { CustomerPaymentMethod } from './entities/customer-payment-method.entity';
import {
  isCardExpired,
  MAX_SAVED_METHODS,
  maskMobileNumber,
  normaliseCardBrand,
} from './payment-methods.constants';
import type { MomoProviderCode } from './payment-methods.constants';
import type { MobileMoneyMethodDto } from './dto/mobile-money-method.dto';
import type {
  PaymentMethodListDto,
  SavedPaymentMethodDto,
} from './dto/payment-method-response.dto';

export const MOMO_NAME_NOT_FOUND =
  "We couldn't find the name on this number. Check the number and the network.";
export const MOMO_LOOKUP_UNAVAILABLE =
  "We can't check the name on this number right now. Please try again later.";
export const METHOD_ALREADY_SAVED = 'This number is already saved.';
export const METHOD_LIMIT_REACHED = `You can save up to ${MAX_SAVED_METHODS} payment methods. Remove one to add another.`;
export const METHOD_NOT_FOUND = 'Payment method not found.';

export interface SecurityContext {
  ip: string | null;
  userAgent: string | null;
}

/** Paystack's reusable card authorization, as sent on `charge.success`. */
export interface PaystackAuthorization {
  authorization_code?: unknown;
  card_type?: unknown;
  brand?: unknown;
  last4?: unknown;
  exp_month?: unknown;
  exp_year?: unknown;
  bank?: unknown;
  channel?: unknown;
  signature?: unknown;
  reusable?: unknown;
}

/** A saved method ready to charge (decrypted). Never logged or returned. */
export type ChargeableMethod =
  | {
      id: number;
      type: 'mobile_money';
      network: MomoProviderCode;
      phone: string;
    }
  | {
      id: number;
      type: 'card';
      authorizationCode: string;
      expired: boolean;
    };

export type CardSaveOutcome =
  | 'saved'
  | 'duplicate'
  | 'not_reusable'
  | 'limit'
  | 'disabled'
  | 'invalid';

@Injectable()
export class PaymentMethodsService {
  constructor(
    @InjectRepository(CustomerPaymentMethod)
    private readonly repo: Repository<CustomerPaymentMethod>,
    private readonly dataSource: DataSource,
    private readonly encryption: PaymentDataEncryptionService,
    private readonly paystack: PaystackService,
    private readonly accountSecurity: AccountSecurityService,
  ) {}

  /** The masked view of one row. Never the number or authorization code. */
  static toDto(
    row: CustomerPaymentMethod,
    now: Date = new Date(),
  ): SavedPaymentMethodDto {
    const base = {
      id: row.id,
      type: row.type,
      isDefault: row.isDefault,
      createdAt: new Date(row.createdAt).toISOString(),
    };
    if (row.type === 'mobile_money') {
      return {
        ...base,
        mobileMoney: {
          network: row.network ?? 'MTN',
          numberMasked: maskMobileNumber(row.numberPrefix, row.numberLast4),
          last4: row.numberLast4 ?? '',
          accountName: row.accountName ?? '',
          nameVerified: row.nameVerified,
        },
        card: null,
      };
    }
    return {
      ...base,
      mobileMoney: null,
      card: {
        brand: row.cardBrand ?? 'card',
        last4: row.cardLast4 ?? '',
        expMonth: row.expMonth ?? 0,
        expYear: row.expYear ?? 0,
        bank: row.cardBank ?? null,
        expired: isCardExpired(row.expMonth, row.expYear, now),
      },
    };
  }

  private async listRows(
    userId: number,
    manager?: EntityManager,
  ): Promise<CustomerPaymentMethod[]> {
    const repo = manager
      ? manager.getRepository(CustomerPaymentMethod)
      : this.repo;
    return repo.find({
      where: { userId },
      order: { isDefault: 'DESC', createdAt: 'DESC', id: 'DESC' },
    });
  }

  async list(userId: number): Promise<PaymentMethodListDto> {
    const rows = await this.listRows(userId);
    return {
      methods: rows.map((r) => PaymentMethodsService.toDto(r)),
      maxMethods: MAX_SAVED_METHODS,
      canSave: this.encryption.isEnabled(),
    };
  }

  /** The name on a wallet. 422 when Paystack can't find it, 503 when unavailable. */
  async resolve(dto: MobileMoneyMethodDto): Promise<{ accountName: string }> {
    const result = await this.paystack.resolveAccount(
      dto.accountNumber,
      dto.network,
    );
    if (result.status === 'resolved')
      return { accountName: result.accountName };
    if (result.status === 'unresolvable') {
      throw new UnprocessableEntityException(MOMO_NAME_NOT_FOUND);
    }
    throw new ServiceUnavailableException(MOMO_LOOKUP_UNAVAILABLE);
  }

  /**
   * Locks the customer's user row, so two concurrent saves can't both pass
   * the limit or both become the first default.
   */
  private async lockOwner(manager: EntityManager, userId: number) {
    const owner = await manager.getRepository(User).findOne({
      where: { id: userId },
      select: { id: true },
      lock: { mode: 'pessimistic_write' },
    });
    if (!owner) throw new NotFoundException('User not found.');
  }

  /**
   * Saves a mobile money number with the name Paystack has on it. Customers
   * must have a looked-up name: an unverified, typed name is not accepted.
   */
  async addMobileMoney(
    userId: number,
    dto: MobileMoneyMethodDto,
    context: SecurityContext,
  ): Promise<SavedPaymentMethodDto> {
    this.encryption.assertEnabled();
    const hashes = this.encryption.hashCandidates(dto.accountNumber);

    // Cheap checks first, so a duplicate or a full list costs no lookup.
    const existing = await this.listRows(userId);
    if (existing.some((r) => r.numberHash && hashes.includes(r.numberHash))) {
      throw new ConflictException(METHOD_ALREADY_SAVED);
    }
    if (existing.length >= MAX_SAVED_METHODS) {
      throw new ConflictException(METHOD_LIMIT_REACHED);
    }

    const { accountName } = await this.resolve(dto);

    const saved = await this.dataSource.transaction(async (manager) => {
      await this.lockOwner(manager, userId);
      const repo = manager.getRepository(CustomerPaymentMethod);
      const rows = await this.listRows(userId, manager);
      if (rows.some((r) => r.numberHash && hashes.includes(r.numberHash))) {
        throw new ConflictException(METHOD_ALREADY_SAVED);
      }
      if (rows.length >= MAX_SAVED_METHODS) {
        throw new ConflictException(METHOD_LIMIT_REACHED);
      }
      const row = await repo.save(
        repo.create({
          userId,
          type: 'mobile_money',
          isDefault: rows.length === 0,
          network: dto.network,
          numberPrefix: dto.accountNumber.slice(0, 3),
          numberLast4: dto.accountNumber.slice(-4),
          accountName: accountName.slice(0, 120),
          nameVerified: true,
          numberEncrypted: this.encryption.encrypt(dto.accountNumber),
          numberHash: hashes[0],
          cardBrand: null,
          cardLast4: null,
          expMonth: null,
          expYear: null,
          cardBank: null,
          authorizationEncrypted: null,
          signatureHash: null,
        }),
      );
      await this.accountSecurity.record(
        {
          userId,
          event: 'payment_method.added',
          details: { type: 'mobile_money', network: dto.network },
          ip: context.ip,
          userAgent: context.userAgent,
        },
        manager,
      );
      return row;
    });
    return PaymentMethodsService.toDto(saved);
  }

  /** Makes one of the caller's methods the default. 404 for anyone else's id. */
  async setDefault(userId: number, id: number): Promise<PaymentMethodListDto> {
    await this.dataSource.transaction(async (manager) => {
      await this.lockOwner(manager, userId);
      const repo = manager.getRepository(CustomerPaymentMethod);
      const row = await repo.findOne({ where: { id, userId } });
      if (!row) throw new NotFoundException(METHOD_NOT_FOUND);
      if (row.isDefault) return;
      await repo.update({ userId, isDefault: true }, { isDefault: false });
      await repo.update({ id, userId }, { isDefault: true });
    });
    return this.list(userId);
  }

  /**
   * Removes one of the caller's methods (hard delete, so the encrypted
   * secret is gone). When it was the default, the newest remaining method
   * becomes the default. 404 for anyone else's id.
   */
  async remove(
    userId: number,
    id: number,
    context: SecurityContext,
  ): Promise<PaymentMethodListDto> {
    await this.dataSource.transaction(async (manager) => {
      await this.lockOwner(manager, userId);
      const repo = manager.getRepository(CustomerPaymentMethod);
      const row = await repo.findOne({ where: { id, userId } });
      if (!row) throw new NotFoundException(METHOD_NOT_FOUND);
      await repo.delete({ id, userId });
      if (row.isDefault) {
        const next = await repo.findOne({
          where: { userId },
          order: { createdAt: 'DESC', id: 'DESC' },
        });
        if (next) await repo.update({ id: next.id }, { isDefault: true });
      }
      await this.accountSecurity.record(
        {
          userId,
          event: 'payment_method.removed',
          details: { type: row.type },
          ip: context.ip,
          userAgent: context.userAgent,
        },
        manager,
      );
    });
    return this.list(userId);
  }

  /**
   * Saves the card from a successful hosted charge. Called only when the
   * customer opted in on that payment (`payments.save_card_requested`).
   * Saves nothing unless the authorization is a reusable card, the customer
   * has room, and this card (by signature) isn't already saved.
   */
  async saveCardFromAuthorization(
    userId: number,
    authorization: PaystackAuthorization | null | undefined,
  ): Promise<CardSaveOutcome> {
    if (!this.encryption.isEnabled()) return 'disabled';
    const a = authorization ?? {};
    if (a.reusable !== true || a.channel !== 'card') return 'not_reusable';
    const code =
      typeof a.authorization_code === 'string' ? a.authorization_code : '';
    const signature = typeof a.signature === 'string' ? a.signature : '';
    const last4 = typeof a.last4 === 'string' ? a.last4 : '';
    const expMonth = Number(a.exp_month);
    const expYear = Number(a.exp_year);
    if (
      !/^AUTH_[A-Za-z0-9]{4,100}$/.test(code) ||
      !signature ||
      !/^\d{4}$/.test(last4) ||
      !(expMonth >= 1 && expMonth <= 12) ||
      !(expYear >= 2000 && expYear <= 2100)
    ) {
      return 'invalid';
    }
    const hashes = this.encryption.hashCandidates(signature);

    return this.dataSource.transaction(async (manager) => {
      await this.lockOwner(manager, userId);
      const repo = manager.getRepository(CustomerPaymentMethod);
      const rows = await this.listRows(userId, manager);
      if (
        rows.some((r) => r.signatureHash && hashes.includes(r.signatureHash))
      ) {
        return 'duplicate' as const;
      }
      if (rows.length >= MAX_SAVED_METHODS) return 'limit' as const;
      await repo.save(
        repo.create({
          userId,
          type: 'card',
          isDefault: rows.length === 0,
          network: null,
          numberPrefix: null,
          numberLast4: null,
          accountName: null,
          nameVerified: false,
          numberEncrypted: null,
          numberHash: null,
          cardBrand: normaliseCardBrand(a.card_type ?? a.brand),
          cardLast4: last4,
          expMonth,
          expYear,
          cardBank:
            typeof a.bank === 'string' && a.bank.trim()
              ? a.bank.trim().slice(0, 100)
              : null,
          authorizationEncrypted: this.encryption.encrypt(code),
          signatureHash: hashes[0],
        }),
      );
      await this.accountSecurity.record(
        {
          userId,
          event: 'payment_method.added',
          details: { type: 'card', source: 'checkout' },
        },
        manager,
      );
      return 'saved' as const;
    });
  }

  /** A caller's method, decrypted for a charge. 404 for anyone else's id. */
  async getChargeable(userId: number, id: number): Promise<ChargeableMethod> {
    this.encryption.assertEnabled();
    const row = await this.repo.findOne({ where: { id, userId } });
    if (!row) throw new NotFoundException(METHOD_NOT_FOUND);
    if (row.type === 'mobile_money') {
      return {
        id: row.id,
        type: 'mobile_money',
        network: row.network ?? 'MTN',
        phone: this.encryption.decrypt(row.numberEncrypted ?? ''),
      };
    }
    return {
      id: row.id,
      type: 'card',
      authorizationCode: this.encryption.decrypt(
        row.authorizationEncrypted ?? '',
      ),
      expired: isCardExpired(row.expMonth, row.expYear),
    };
  }
}
