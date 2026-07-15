import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

interface PaystackResponse<T> {
  status: boolean;
  message: string;
  data: T;
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

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as PaystackResponse<T>;
    if (!json.status) {
      this.logger.error(`Paystack POST ${path} failed: ${json.message}`);
      throw new InternalServerErrorException(`Payment provider error: ${json.message}`);
    }
    return json.data;
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, { headers: this.headers });
    const json = (await res.json()) as PaystackResponse<T>;
    if (!json.status) {
      this.logger.error(`Paystack GET ${path} failed: ${json.message}`);
      throw new InternalServerErrorException(`Payment provider error: ${json.message}`);
    }
    return json.data;
  }

  /** Verify that a webhook request genuinely came from Paystack */
  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    const hash = crypto.createHmac('sha512', this.secretKey).update(rawBody).digest('hex');
    return hash === signature;
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
