import type { ExecutionContext } from '@nestjs/common';
import { PaymentHistoryThrottlerGuard } from './payment-history-throttler.guard';

const ctx = (query: unknown) =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ query }) }),
  }) as unknown as ExecutionContext;

describe('PaymentHistoryThrottlerGuard.shouldSkip', () => {
  const guard = new PaymentHistoryThrottlerGuard(
    ...([
      { throttlers: [] },
      {},
      { getAllAndOverride: jest.fn() },
    ] as unknown as [never, never, never]),
  ) as unknown as { shouldSkip(c: ExecutionContext): Promise<boolean> };

  it('skips the legacy no-parameter form', async () => {
    await expect(guard.shouldSkip(ctx({}))).resolves.toBe(true);
    await expect(guard.shouldSkip(ctx(undefined))).resolves.toBe(true);
  });

  it('throttles the paginated form', async () => {
    await expect(guard.shouldSkip(ctx({ page: '1' }))).resolves.toBe(false);
    await expect(guard.shouldSkip(ctx({ customerId: '2' }))).resolves.toBe(
      false,
    );
  });
});
