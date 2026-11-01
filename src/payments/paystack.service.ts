import { Injectable, BadGatewayException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

interface PaystackResponse<T> {
  status: boolean;
  message: string;
  data: T;
}

/**
 * A refusal by Paystack, still the 502 every caller already handles, but
 * carrying Paystack's own HTTP status so a caller that needs to (the account
 * name lookup) can tell "this account doesn't exist" from "try later".
 */
export class PaystackRequestError extends BadGatewayException {
  constructor(
    message: string,
    readonly upstreamStatus: number,
  ) {
    super(message);
  }
}

/**
 * The outcome of an account name lookup (`resolveAccount`):
 * - `resolved`: Paystack named the account holder.
 * - `unresolvable`: Paystack says the number/bank pair is wrong (400/422).
 * - `unavailable`: the lookup could not be made right now (429, 5xx,
 *   network, timeout, or an unexpected reply).
 */
export type ResolveAccountResult =
  | { status: 'resolved'; accountName: string }
  | { status: 'unresolvable' }
  | { status: 'unavailable' };

/** Paystack statuses meaning "the number and bank code don't match an account". */
const UNRESOLVABLE_STATUSES = new Set([400, 422]);
/** A name lookup that takes longer than this counts as unavailable. */
export const RESOLVE_ACCOUNT_TIMEOUT_MS = 8_000;

/** `••••1234`: only the last 4 characters, for logs. */
export function maskForLog(value: string | null | undefined): string {
  const v = (value ?? '').replace(/\s+/g, '');
  return v.length <= 4 ? '••••' : `••••${v.slice(-4)}`;
}

@Injectable()
export class PaystackService {
  private readonly logger = new Logger(PaystackService.name);
  private readonly baseUrl = 'https://api.paystack.co';
  private readonly secretKey: string;

  constructor(private readonly config: ConfigService) {
    this.secretKey = this.config.getOrThrow<string>('PAYSTACK_SECRET_KEY');
  }

  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.secretKey}`,
      'Content-Type': 'application/json',
    };
  }

  private async post<T>(
    path: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as PaystackResponse<T>;
    if (!json.status) {
      this.logger.error(`Paystack POST ${path} failed: ${json.message}`);
      // QA PAY-13: a refusal by Paystack is an upstream failure (502), not a
      // bug in JinVa (500); the message says what Paystack said.
      throw new BadGatewayException(
        `The payment provider couldn't complete this: ${json.message}`,
      );
    }
    return json.data;
  }

  /**
   * `logPath` replaces `path` in the error log when the path carries
   * something that must not be logged (an account number).
   */
  private async get<T>(
    path: string,
    opts: { logPath?: string; signal?: AbortSignal } = {},
  ): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: this.headers,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    const json = (await res.json()) as PaystackResponse<T>;
    if (!json.status) {
      this.logger.error(
        `Paystack GET ${opts.logPath ?? path} failed: ${json.message}`,
      );
      // QA PAY-13: a refusal by Paystack is an upstream failure (502), not a
      // bug in JinVa (500); the message says what Paystack said.
      throw new PaystackRequestError(
        `The payment provider couldn't complete this: ${json.message}`,
        res.status,
      );
    }
    return json.data;
  }

  /**
   * Verify that a webhook request genuinely came from Paystack.
   *
   * security-report.md finding #7: uses `crypto.timingSafeEqual` rather than
   * `===`, which short-circuits on the first differing character — a
   * textbook timing side-channel shape for a signature comparison that MUST
   * NOT be forgeable.
   */
  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    const hash = crypto
      .createHmac('sha512', this.secretKey)
      .update(rawBody)
      .digest('hex');

    const expected = Buffer.from(hash, 'hex');
    const provided = Buffer.from(signature ?? '', 'hex');
    return (
      expected.length === provided.length &&
      crypto.timingSafeEqual(expected, provided)
    );
  }

  /**
   * Step 1 of the payment flow.
   * Returns an authorization_url to redirect the customer to, plus an access_code
   * for Paystack's inline JS popup.
   */
  async initializeTransaction(params: {
    email: string;
    amountGhs: number;
    reference: string;
    callbackUrl?: string;
    metadata?: Record<string, unknown>;
    /**
     * B5c: the checkout channels in display order. Sent only when defined, so
     * a customer with no saved preference gets exactly today's payload.
     */
    channels?: string[];
  }) {
    return this.post<{
      authorization_url: string;
      access_code: string;
      reference: string;
    }>('/transaction/initialize', {
      email: params.email,
      amount: Math.round(params.amountGhs * 100), // GHS → pesewas
      reference: params.reference,
      currency: 'GHS',
      callback_url: params.callbackUrl,
      metadata: params.metadata ?? {},
      ...(params.channels ? { channels: [...params.channels] } : {}),
    });
  }

  /**
   * Verify a transaction after the customer completes payment.
   * Use on the callback redirect as a belt-and-suspenders check alongside the webhook.
   */
  async verifyTransaction(reference: string) {
    return this.get<{
      status: string; // 'success' | 'failed' | 'abandoned'
      reference: string;
      amount: number; // pesewas
      currency: string;
      paid_at: string;
      channel: string;
      customer: { email: string; id: number };
    }>(`/transaction/verify/${encodeURIComponent(reference)}`);
  }

  /**
   * Refund a transaction.
   * If amountGhs is omitted the full transaction amount is refunded.
   */
  async createRefund(transactionReference: string, amountGhs?: number) {
    const body: Record<string, unknown> = { transaction: transactionReference };
    if (amountGhs !== undefined) body.amount = Math.round(amountGhs * 100);
    return this.post('/refund', body);
  }

  /**
   * Register an artisan's bank account or mobile money number as a Transfer Recipient.
   * The returned recipient_code is saved on the ArtisanProfile and reused for every payout.
   *
   * Mobile money bank codes (Ghana): 'MTN' | 'VOD' | 'ATL'
   * Bank type: use 'ghipss' and pass the Paystack bank_code for the bank.
   */
  async createTransferRecipient(params: {
    type: 'mobile_money' | 'ghipss';
    name: string;
    accountNumber: string;
    bankCode: string;
  }) {
    return this.post<{
      recipient_code: string;
      id: number;
      type: string;
      name: string;
      account_number: string;
    }>('/transferrecipient', {
      type: params.type,
      name: params.name,
      account_number: params.accountNumber,
      bank_code: params.bankCode,
      currency: 'GHS',
    });
  }

  /**
   * Artisan fixes (B6): the banks Paystack supports in a country, for the
   * payout bank picker. Cached by `BankListService`; never called per user.
   */
  async listBanks(country: 'ghana' = 'ghana') {
    return this.get<
      Array<{
        name?: string;
        code?: string;
        type?: string;
        active?: boolean;
        is_deleted?: boolean | null;
      }>
    >(`/bank?country=${encodeURIComponent(country)}&perPage=100`);
  }

  /**
   * Account name lookup: the name Paystack has on a mobile money number
   * (bank code `MTN` | `VOD` | `ATL`) or a bank account (its ghipss code).
   *
   * Never throws. A 400/422 from Paystack means the number and bank code
   * don't match an account (`unresolvable`); anything else that goes wrong,
   * a 429, a 5xx, a timeout, a network error or a reply without a name, is
   * `unavailable`, so a caller can fall back instead of failing. The account
   * number never appears in a log line.
   */
  async resolveAccount(
    accountNumber: string,
    bankCode: string,
  ): Promise<ResolveAccountResult> {
    const query =
      `account_number=${encodeURIComponent(accountNumber)}` +
      `&bank_code=${encodeURIComponent(bankCode)}`;
    const logPath = `/bank/resolve (account ${maskForLog(accountNumber)}, bank ${bankCode})`;
    try {
      const data = await this.get<{
        account_number?: string;
        account_name?: string | null;
      }>(`/bank/resolve?${query}`, {
        logPath,
        signal: AbortSignal.timeout(RESOLVE_ACCOUNT_TIMEOUT_MS),
      });
      const accountName =
        typeof data?.account_name === 'string'
          ? data.account_name.replace(/\s+/g, ' ').trim()
          : '';
      if (!accountName) return { status: 'unavailable' };
      return { status: 'resolved', accountName };
    } catch (err) {
      if (
        err instanceof PaystackRequestError &&
        UNRESOLVABLE_STATUSES.has(err.upstreamStatus)
      ) {
        return { status: 'unresolvable' };
      }
      if (!(err instanceof PaystackRequestError)) {
        this.logger.warn(
          `Paystack GET ${logPath} failed: ${(err as Error)?.name ?? 'Error'}`,
        );
      }
      return { status: 'unavailable' };
    }
  }

  /**
   * Send money from your Paystack balance to an artisan.
   * Requires Transfers to be enabled on your Paystack dashboard.
   */
  async initiateTransfer(params: {
    amountGhs: number;
    recipientCode: string;
    reference: string;
    reason: string;
  }) {
    return this.post<{
      transfer_code: string;
      status: string;
      id: number;
    }>('/transfer', {
      source: 'balance',
      amount: Math.round(params.amountGhs * 100),
      recipient: params.recipientCode,
      reference: params.reference,
      reason: params.reason,
    });
  }
}
