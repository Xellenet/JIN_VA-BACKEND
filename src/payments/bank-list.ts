import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { PaystackService } from './paystack.service';

/** One Ghana bank, as the payout bank picker needs it. */
export interface BankOption {
  code: string;
  name: string;
}

/** The raw entry Paystack's `GET /bank?country=ghana` returns. */
export interface PaystackBank {
  name?: string;
  code?: string;
  type?: string;
  active?: boolean;
  is_deleted?: boolean | null;
}

export const BANK_LIST_TTL_MS = 24 * 60 * 60 * 1000;
export const BANK_LIST_UNAVAILABLE =
  'The bank list is unavailable right now. Please try again shortly.';

/**
 * Bank transfers only (`ghipss`), active, de-duplicated by code and sorted
 * by name. Mobile money networks are offered separately (MTN/VOD/ATL).
 */
export function toBankOptions(raw: PaystackBank[]): BankOption[] {
  const byCode = new Map<string, BankOption>();
  for (const b of raw ?? []) {
    if (!b || typeof b.code !== 'string' || typeof b.name !== 'string')
      continue;
    if ((b.type ?? 'ghipss') !== 'ghipss') continue;
    if (b.active === false || b.is_deleted === true) continue;
    const code = b.code.trim();
    const name = b.name.trim();
    if (!code || !name || byCode.has(code)) continue;
    byCode.set(code, { code, name });
  }
  return [...byCode.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The last good list, shared process-wide so the profile DTO can turn a
 * stored bank code into a name without a Paystack call (`bankNameFor`).
 */
const store: { banks: BankOption[] | null; fetchedAt: number } = {
  banks: null,
  fetchedAt: 0,
};

/** The cached bank name for a code, or `null` when unknown. */
export function bankNameFor(code: string | null | undefined): string | null {
  if (!code || !store.banks) return null;
  return store.banks.find((b) => b.code === code)?.name ?? null;
}

/** Test-only: forget the cached list. */
export function resetBankListCache(): void {
  store.banks = null;
  store.fetchedAt = 0;
}

/**
 * Artisan fixes (B6): Paystack's Ghana bank list for the payout bank picker,
 * cached for 24 hours. On a Paystack failure the last good list is served;
 * with none at all the caller gets a 502.
 */
@Injectable()
export class BankListService {
  private readonly logger = new Logger(BankListService.name);
  private inFlight: Promise<BankOption[]> | null = null;

  constructor(private readonly paystack: PaystackService) {}

  async list(): Promise<BankOption[]> {
    if (store.banks && Date.now() - store.fetchedAt < BANK_LIST_TTL_MS) {
      return store.banks;
    }
    if (!this.inFlight) {
      this.inFlight = this.refresh().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async refresh(): Promise<BankOption[]> {
    try {
      const banks = toBankOptions(await this.paystack.listBanks('ghana'));
      if (banks.length === 0) throw new Error('Empty bank list');
      store.banks = banks;
      store.fetchedAt = Date.now();
      return banks;
    } catch (err) {
      this.logger.warn(
        `Bank list refresh failed: ${(err as Error)?.name ?? 'Error'}`,
      );
      if (store.banks) return store.banks;
      throw new BadGatewayException(BANK_LIST_UNAVAILABLE);
    }
  }
}
