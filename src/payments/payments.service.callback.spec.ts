import { PaymentsService } from './payments.service';

/**
 * The Paystack return URL: built per job from FRONTEND_URL, and the
 * `/payments/callback` safety net that forwards a browser to the job's pay
 * page. Tested on the two methods alone (no Nest module needed).
 */
describe('PaymentsService callback URLs', () => {
  const make = (
    env: Record<string, string | undefined>,
    found: {
      byReference?: { jobId: number } | null;
      byPaidReference?: { jobId: number } | null;
      charge?: { paymentId: number } | null;
      byId?: { jobId: number } | null;
    } = {},
  ) => {
    const svc = Object.create(PaymentsService.prototype) as PaymentsService;
    const repo = {
      findOne: jest.fn(({ where }: { where: Record<string, unknown> }) => {
        if ('reference' in where)
          return Promise.resolve(found.byReference ?? null);
        if ('paidReference' in where)
          return Promise.resolve(found.byPaidReference ?? null);
        if ('id' in where) return Promise.resolve(found.byId ?? null);
        return Promise.resolve(null);
      }),
    };
    const chargeRepo = {
      findOne: jest.fn(() => Promise.resolve(found.charge ?? null)),
    };
    Object.assign(svc, {
      config: { get: (k: string) => env[k] },
      repo,
      chargeRepo,
    });
    return { svc, repo, chargeRepo };
  };

  describe('paymentCallbackUrl', () => {
    it('points at the job pay page on the frontend', () => {
      const { svc } = make({ FRONTEND_URL: 'https://app.example.com/' });
      expect(svc.paymentCallbackUrl(42)).toBe(
        'https://app.example.com/dashboard/user/jobs/42/pay',
      );
    });

    it('ignores a PAYSTACK_CALLBACK_URL aimed at the backend when FRONTEND_URL is set', () => {
      const { svc } = make({
        FRONTEND_URL: 'https://app.example.com',
        PAYSTACK_CALLBACK_URL:
          'https://api.example.com/api/v1/payments/callback',
      });
      expect(svc.paymentCallbackUrl(7)).toBe(
        'https://app.example.com/dashboard/user/jobs/7/pay',
      );
    });

    it('falls back to PAYSTACK_CALLBACK_URL, then to none', () => {
      expect(
        make({
          PAYSTACK_CALLBACK_URL: 'https://x.example.com/cb',
        }).svc.paymentCallbackUrl(1),
      ).toBe('https://x.example.com/cb');
      expect(make({}).svc.paymentCallbackUrl(1)).toBeUndefined();
    });
  });

  describe('callbackRedirectUrl', () => {
    const env = { FRONTEND_URL: 'https://app.example.com' };

    it('sends a known reference to its job pay page, reference kept', async () => {
      const { svc } = make(env, { byReference: { jobId: 4 } });
      await expect(
        svc.callbackRedirectUrl('jinva-1-4-1793728186651'),
      ).resolves.toBe(
        'https://app.example.com/dashboard/user/jobs/4/pay?reference=jinva-1-4-1793728186651',
      );
    });

    it('finds the job through a paid reference or a charge', async () => {
      await expect(
        make(env, { byPaidReference: { jobId: 9 } }).svc.callbackRedirectUrl(
          'jinva-ch-9-1',
        ),
      ).resolves.toContain('/jobs/9/pay?reference=jinva-ch-9-1');
      await expect(
        make(env, {
          charge: { paymentId: 3 },
          byId: { jobId: 11 },
        }).svc.callbackRedirectUrl('jinva-ho-11-1'),
      ).resolves.toContain('/jobs/11/pay?reference=jinva-ho-11-1');
    });

    it('sends unknown, missing or malformed references to the jobs list without querying', async () => {
      const { svc, repo } = make(env);
      await expect(svc.callbackRedirectUrl('jinva-unknown-1')).resolves.toBe(
        'https://app.example.com/dashboard/user/jobs',
      );
      repo.findOne.mockClear();
      for (const bad of [
        undefined,
        '',
        'a b',
        '<script>',
        'x'.repeat(101),
        '../../etc',
      ]) {
        await expect(svc.callbackRedirectUrl(bad)).resolves.toBe(
          'https://app.example.com/dashboard/user/jobs',
        );
      }
      expect(repo.findOne).not.toHaveBeenCalled();
    });

    it('never redirects off the frontend origin', async () => {
      const { svc } = make(env, { byReference: { jobId: 4 } });
      const url = await svc.callbackRedirectUrl('jinva-1-4-1');
      expect(url.startsWith('https://app.example.com/')).toBe(true);
    });
  });
});
