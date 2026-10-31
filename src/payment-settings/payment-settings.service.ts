import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { User } from '@users/entities/user.entity';
import { SUCCESS_MESSAGES } from '@common/constants/success-messages.constants';
import { AccountSecurityService } from '../account-security/account-security.service';
import { CustomerPaymentSettings } from './entities/customer-payment-settings.entity';
import { UpdatePaymentSettingsDto } from './dto/update-payment-settings.dto';
import { PaymentSettingsResponseDto } from './dto/payment-settings-response.dto';

/** The two editable fields, in the order `fields_changed` lists them. */
const EDITABLE_FIELDS = ['preferredChannel', 'momoNetwork'] as const;
type EditableField = (typeof EDITABLE_FIELDS)[number];

export interface PaymentSettingsRequestContext {
  ip: string | null;
  userAgent: string | null;
}

@Injectable()
export class PaymentSettingsService {
  constructor(
    @InjectRepository(CustomerPaymentSettings)
    private readonly settingsRepo: Repository<CustomerPaymentSettings>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly dataSource: DataSource,
    private readonly accountSecurity: AccountSecurityService,
  ) {}

  /** The caller's account email and suspension flag. Never another user's. */
  private async loadOwner(
    userId: number,
  ): Promise<Pick<User, 'id' | 'email' | 'isSuspended'>> {
    const user = await this.userRepo.findOne({
      where: { id: userId },
      select: { id: true, email: true, isSuspended: true },
    });
    if (!user) throw new NotFoundException('User not found.');
    return user;
  }

  private toResponse(
    owner: Pick<User, 'email' | 'isSuspended'>,
    row: CustomerPaymentSettings | null,
  ): PaymentSettingsResponseDto {
    return {
      preferredChannel: row?.preferredChannel ?? null,
      momoNetwork: row?.momoNetwork ?? null,
      receiptEmail: owner.email,
      updatedAt: row?.updatedAt ? new Date(row.updatedAt).toISOString() : null,
      editable: !owner.isSuspended,
    };
  }

  /** B5 GET. Never creates a row. */
  async getSettings(userId: number) {
    const [owner, row] = await Promise.all([
      this.loadOwner(userId),
      this.settingsRepo.findOne({ where: { userId } }),
    ]);
    return {
      message: SUCCESS_MESSAGES.PAYMENT_SETTINGS.RETRIEVED,
      data: this.toResponse(owner, row),
    };
  }

  /** The names of the fields this patch really changes. */
  static changedFields(
    current: Pick<CustomerPaymentSettings, EditableField> | null,
    patch: UpdatePaymentSettingsDto,
  ): EditableField[] {
    return EDITABLE_FIELDS.filter((field) => {
      const next = patch[field];
      if (next === undefined) return false;
      return (current?.[field] ?? null) !== next;
    });
  }

  /**
   * B5 PATCH. A body with no real change is a no-op: nothing is written and no
   * event is recorded. A real change is saved and the `payment_settings.updated`
   * event (field names only) is written in the same transaction.
   */
  async updateSettings(
    userId: number,
    patch: UpdatePaymentSettingsDto,
    context: PaymentSettingsRequestContext,
  ) {
    const owner = await this.loadOwner(userId);

    const saved = await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(CustomerPaymentSettings);
      const current = await repo.findOne({
        where: { userId },
        lock: { mode: 'pessimistic_write' },
      });
      const changed = PaymentSettingsService.changedFields(current, patch);
      if (changed.length === 0) return current;

      const row =
        current ??
        repo.create({ userId, preferredChannel: null, momoNetwork: null });
      for (const field of changed) {
        (row as unknown as Record<EditableField, string | null>)[field] =
          patch[field] ?? null;
      }
      const persisted = await repo.save(row);
      await this.accountSecurity.record(
        {
          userId,
          event: 'payment_settings.updated',
          fieldsChanged: [...changed],
          ip: context.ip,
          userAgent: context.userAgent,
        },
        manager,
      );
      return persisted;
    });

    return {
      message: SUCCESS_MESSAGES.PAYMENT_SETTINGS.UPDATED,
      data: this.toResponse(owner, saved),
    };
  }

  /** Account purge (SEC-37). */
  async deleteForUser(manager: EntityManager, userId: number): Promise<void> {
    await manager.getRepository(CustomerPaymentSettings).delete({ userId });
  }
}
