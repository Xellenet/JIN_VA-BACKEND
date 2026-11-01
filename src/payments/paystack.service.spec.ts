import * as crypto from 'crypto';
import { BadGatewayException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PaystackRequestError,
  PaystackService,
  maskForLog,
} from './paystack.service';

const SECRET = 'sk_test_unit';

describe('PaystackService', () => {
  let service: PaystackService;
  let fetchSpy: jest.SpiedFunction<typeof fetch>;

  const config = {
    getOrThrow: jest.fn((key: string) => {
      if (key === 'PAYSTACK_SECRET_KEY') return SECRET;
      throw new Error(`missing ${key}`);
    }),
  } as unknown as ConfigService;

  /** A minimal Response stand-in: the service only reads `.json()`. */
  const reply = (body: unknown, ok = true) =>
    ({
      ok,
      status: ok ? 200 : 400,
      json: () => Promise.resolve(body),
    }) as Response;

  /** A reply with an explicit HTTP status. */
  const replyWith = (status: number, body: unknown) =>
    ({
      ok: status < 400,
      status,
      json: () => Promise.resolve(body),
    }) as Response;

  /** The service always passes a string URL, never a Request/URL object. */
  const lastCall = () => {
    const [url, init] = fetchSpy.mock.calls[0];
    return {
      url: url as string,
      init: init!,
      body: init?.body ? (JSON.parse(init.body as string) as unknown) : null,
    };
  };

  beforeEach(() => {
    service = new PaystackService(config);
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('refuses to construct without a secret key', () => {
    const empty = {
      getOrThrow: jest.fn(() => {
        throw new Error('PAYSTACK_SECRET_KEY is not set');
      }),
    } as unknown as ConfigService;

    expect(() => new PaystackService(empty)).toThrow(
      'PAYSTACK_SECRET_KEY is not set',
    );
  });

  describe('verifyWebhookSignature', () => {
    const body = JSON.stringify({ event: 'charge.success', data: {} });
    const sign = (raw: string, key = SECRET) =>
      crypto.createHmac('sha512', key).update(raw).digest('hex');

    it('accepts an HMAC-SHA512 signature made with the secret key', () => {
      expect(service.verifyWebhookSignature(body, sign(body))).toBe(true);
    });

    it('rejects a signature made with a different key', () => {
      expect(
        service.verifyWebhookSignature(body, sign(body, 'sk_test_other')),
      ).toBe(false);
    });

    it('rejects a signature for a tampered body', () => {
      expect(service.verifyWebhookSignature(body + ' ', sign(body))).toBe(
        false,
      );
    });

    it('rejects a missing or truncated signature without throwing', () => {
      expect(
        service.verifyWebhookSignature(body, undefined as unknown as string),
      ).toBe(false);
      expect(
        service.verifyWebhookSignature(body, sign(body).slice(0, 10)),
      ).toBe(false);
    });
  });

  describe('initializeTransaction', () => {
    it('POSTs the amount in pesewas, GHS currency and bearer auth', async () => {
      const data = {
        authorization_url: 'https://checkout.example.com/abc',
        access_code: 'ac_unit',
        reference: 'jinva-1-2-3',
      };
      fetchSpy.mockResolvedValueOnce(
        reply({ status: true, message: 'ok', data }),
      );

      const result = await service.initializeTransaction({
        email: 'kofi@example.com',
        amountGhs: 150.25,
        reference: 'jinva-1-2-3',
        callbackUrl: 'https://app.example.com/pay/callback',
        metadata: { jobId: 1 },
      });

      expect(result).toEqual(data);
      const { url, init, body } = lastCall();
      expect(url).toBe('https://api.paystack.co/transaction/initialize');
      expect(init.method).toBe('POST');
      expect(init.headers).toEqual({
        Authorization: `Bearer ${SECRET}`,
        'Content-Type': 'application/json',
      });
      expect(body).toEqual({
        email: 'kofi@example.com',
        amount: 15025,
        reference: 'jinva-1-2-3',
        currency: 'GHS',
        callback_url: 'https://app.example.com/pay/callback',
        metadata: { jobId: 1 },
      });
    });

    it('B5c: sends no channels key at all when none are given (E-5.9)', async () => {
      fetchSpy.mockResolvedValueOnce(
        reply({ status: true, message: 'ok', data: {} }),
      );
      await service.initializeTransaction({
        email: 'kofi@example.com',
        amountGhs: 10,
        reference: 'jinva-1-2-4',
      });
      expect(Object.keys(lastCall().body as object)).not.toContain('channels');
    });

    it('B5c: sends the channels in the given order when provided', async () => {
      fetchSpy.mockResolvedValueOnce(
        reply({ status: true, message: 'ok', data: {} }),
      );
      const channels = ['mobile_money', 'card', 'bank'];
      await service.initializeTransaction({
        email: 'kofi@example.com',
        amountGhs: 10,
        reference: 'jinva-1-2-5',
        channels,
      });
      expect(lastCall().body).toMatchObject({
        channels: ['mobile_money', 'card', 'bank'],
      });
    });

    it('defaults metadata to an empty object', async () => {
      fetchSpy.mockResolvedValueOnce(
        reply({ status: true, message: 'ok', data: {} }),
      );

      await service.initializeTransaction({
        email: 'kofi@example.com',
        amountGhs: 10,
        reference: 'jinva-ref',
      });

      expect(lastCall().body).toMatchObject({ amount: 1000, metadata: {} });
    });

    it('turns a status:false body into a 502 carrying the provider message', async () => {
      fetchSpy.mockResolvedValueOnce(
        reply(
          { status: false, message: 'Duplicate Transaction Reference' },
          false,
        ),
      );

      const call = service.initializeTransaction({
        email: 'kofi@example.com',
        amountGhs: 10,
        reference: 'jinva-dup',
      });

      await expect(call).rejects.toBeInstanceOf(BadGatewayException);
      await expect(call).rejects.toThrow(
        "The payment provider couldn't complete this: Duplicate Transaction Reference",
      );
    });

    it('propagates a network failure from fetch', async () => {
      fetchSpy.mockRejectedValueOnce(new TypeError('fetch failed'));

      await expect(
        service.initializeTransaction({
          email: 'kofi@example.com',
          amountGhs: 10,
          reference: 'jinva-net',
        }),
      ).rejects.toThrow('fetch failed');
    });
  });

  describe('verifyTransaction', () => {
    it('GETs the URL-encoded reference with auth headers and no body', async () => {
      const data = { status: 'success', reference: 'ref/1', amount: 1000 };
      fetchSpy.mockResolvedValueOnce(
        reply({ status: true, message: 'ok', data }),
      );

      await expect(service.verifyTransaction('ref/1 x')).resolves.toEqual(data);

      const { url, init } = lastCall();
      expect(url).toBe(
        'https://api.paystack.co/transaction/verify/ref%2F1%20x',
      );
      expect(init.method).toBeUndefined();
      expect(init.body).toBeUndefined();
      expect(init.headers).toMatchObject({ Authorization: `Bearer ${SECRET}` });
    });

    it('turns a status:false body into a 502', async () => {
      fetchSpy.mockResolvedValueOnce(
        reply({ status: false, message: 'Transaction reference not found' }),
      );

      await expect(service.verifyTransaction('missing')).rejects.toThrow(
        new BadGatewayException(
          "The payment provider couldn't complete this: Transaction reference not found",
        ),
      );
    });
  });

  describe('createRefund', () => {
    it('refunds the full transaction when no amount is given', async () => {
      fetchSpy.mockResolvedValueOnce(
        reply({ status: true, message: 'ok', data: { id: 9 } }),
      );

      await expect(service.createRefund('jinva-ref')).resolves.toEqual({
        id: 9,
      });

      const { url, body } = lastCall();
      expect(url).toBe('https://api.paystack.co/refund');
      expect(body).toEqual({ transaction: 'jinva-ref' });
    });

    it('sends a partial amount in pesewas', async () => {
      fetchSpy.mockResolvedValueOnce(
        reply({ status: true, message: 'ok', data: {} }),
      );

      await service.createRefund('jinva-ref', 12.5);

      expect(lastCall().body).toEqual({
        transaction: 'jinva-ref',
        amount: 1250,
      });
    });

    it('surfaces a refused refund as a 502', async () => {
      fetchSpy.mockResolvedValueOnce(
        reply({
          status: false,
          message: 'Transaction has been fully reversed',
        }),
      );

      await expect(service.createRefund('jinva-ref', 5)).rejects.toBeInstanceOf(
        BadGatewayException,
      );
    });
  });

  describe('createTransferRecipient', () => {
    it('maps the params to Paystack field names in GHS', async () => {
      const data = { recipient_code: 'RCP_unit', id: 1 };
      fetchSpy.mockResolvedValueOnce(
        reply({ status: true, message: 'ok', data }),
      );

      await expect(
        service.createTransferRecipient({
          type: 'mobile_money',
          name: 'Kofi Mensah',
          accountNumber: '0240000000',
          bankCode: 'MTN',
        }),
      ).resolves.toEqual(data);

      const { url, body } = lastCall();
      expect(url).toBe('https://api.paystack.co/transferrecipient');
      expect(body).toEqual({
        type: 'mobile_money',
        name: 'Kofi Mensah',
        account_number: '0240000000',
        bank_code: 'MTN',
        currency: 'GHS',
      });
    });
  });

  describe('initiateTransfer', () => {
    it('transfers from balance with the amount in pesewas', async () => {
      const data = { transfer_code: 'TRF_unit', status: 'pending', id: 3 };
      fetchSpy.mockResolvedValueOnce(
        reply({ status: true, message: 'ok', data }),
      );

      await expect(
        service.initiateTransfer({
          amountGhs: 142.5,
          recipientCode: 'RCP_unit',
          reference: 'jinva-tr-1-1',
          reason: 'JinVa payout for job #1',
        }),
      ).resolves.toEqual(data);

      const { url, init, body } = lastCall();
      expect(url).toBe('https://api.paystack.co/transfer');
      expect(init.method).toBe('POST');
      expect(body).toEqual({
        source: 'balance',
        amount: 14250,
        recipient: 'RCP_unit',
        reference: 'jinva-tr-1-1',
        reason: 'JinVa payout for job #1',
      });
    });

    it('surfaces a disabled-transfers refusal as a 502', async () => {
      fetchSpy.mockResolvedValueOnce(
        reply({
          status: false,
          message: 'You cannot initiate third party payouts',
        }),
      );

      await expect(
        service.initiateTransfer({
          amountGhs: 1,
          recipientCode: 'RCP_unit',
          reference: 'jinva-tr-x',
          reason: 'x',
        }),
      ).rejects.toThrow('You cannot initiate third party payouts');
    });
  });
  describe('resolveAccount', () => {
    let logs: string[];
    beforeEach(() => {
      logs = [];
      const capture = (m: unknown) => {
        logs.push(String(m));
      };
      jest
        .spyOn(
          (service as unknown as { logger: { error: (m: unknown) => void } })
            .logger,
          'error',
        )
        .mockImplementation(capture);
      jest
        .spyOn(
          (service as unknown as { logger: { warn: (m: unknown) => void } })
            .logger,
          'warn',
        )
        .mockImplementation(capture);
    });

    it('returns the account name and URL-encodes both parameters', async () => {
      fetchSpy.mockResolvedValueOnce(
        reply({
          status: true,
          message: 'Account number resolved',
          data: {
            account_number: '0240000000',
            account_name: ' KOFI  ASANTE ',
          },
        }),
      );

      await expect(
        service.resolveAccount('0240000000', 'GH&01 0'),
      ).resolves.toEqual({ status: 'resolved', accountName: 'KOFI ASANTE' });

      const { url, init } = lastCall();
      expect(url).toBe(
        'https://api.paystack.co/bank/resolve?account_number=0240000000&bank_code=GH%2601%200',
      );
      expect(init.method).toBeUndefined();
      expect(init.signal).toBeDefined();
    });

    it.each([400, 422])(
      'maps a Paystack %i to unresolvable without logging the number',
      async (status) => {
        fetchSpy.mockResolvedValueOnce(
          replyWith(status, {
            status: false,
            message:
              'Could not resolve account name. Check parameters or try again.',
          }),
        );
        await expect(
          service.resolveAccount('0240000000', 'MTN'),
        ).resolves.toEqual({ status: 'unresolvable' });
        expect(logs.join('\n')).not.toContain('0240000000');
        expect(logs.join('\n')).toContain('••••0000');
      },
    );

    it.each([429, 500, 503, 200])(
      'maps a Paystack %i refusal to unavailable',
      async (status) => {
        fetchSpy.mockResolvedValueOnce(
          replyWith(status, { status: false, message: 'Rate limit exceeded' }),
        );
        await expect(
          service.resolveAccount('0240000000', 'MTN'),
        ).resolves.toEqual({ status: 'unavailable' });
      },
    );

    it('maps a network error, a timeout and a non-JSON reply to unavailable', async () => {
      fetchSpy.mockRejectedValueOnce(new TypeError('fetch failed'));
      await expect(
        service.resolveAccount('0240000000', 'MTN'),
      ).resolves.toEqual({ status: 'unavailable' });

      fetchSpy.mockRejectedValueOnce(
        Object.assign(new Error('timed out'), { name: 'TimeoutError' }),
      );
      await expect(
        service.resolveAccount('0240000000', 'VOD'),
      ).resolves.toEqual({ status: 'unavailable' });

      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 502,
        json: () => Promise.reject(new SyntaxError('Unexpected token <')),
      } as unknown as Response);
      await expect(
        service.resolveAccount('0240000000', 'ATL'),
      ).resolves.toEqual({ status: 'unavailable' });

      expect(logs.join('\n')).not.toContain('0240000000');
    });

    it('treats a reply without a name as unavailable', async () => {
      fetchSpy.mockResolvedValueOnce(
        reply({ status: true, message: 'ok', data: { account_name: '  ' } }),
      );
      await expect(
        service.resolveAccount('0240000000', 'MTN'),
      ).resolves.toEqual({ status: 'unavailable' });

      fetchSpy.mockResolvedValueOnce(
        reply({ status: true, message: 'ok', data: null }),
      );
      await expect(
        service.resolveAccount('0240000000', 'MTN'),
      ).resolves.toEqual({ status: 'unavailable' });
    });
  });

  describe('PaystackRequestError and maskForLog', () => {
    it('is still a 502 and carries the upstream status', () => {
      const err = new PaystackRequestError('nope', 422);
      expect(err.getStatus()).toBe(502);
      expect(err.upstreamStatus).toBe(422);
    });

    it('keeps only the last 4 characters', () => {
      expect(maskForLog('0240001234')).toBe('••••1234');
      expect(maskForLog('123')).toBe('••••');
      expect(maskForLog(null)).toBe('••••');
    });
  });
});
