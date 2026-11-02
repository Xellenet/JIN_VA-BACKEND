import { NotFoundException } from '@nestjs/common';
import { PaymentStatus } from '@common/types/enums';
import { qbMock } from '../customer-insights/testing/qb-mock';
import {
  clientName,
  failureReasonOf,
  FORMER_CLIENT,
  hasPayout,
  queryBalances,
  resolveArtisanProfileId,
  STAGE_SQL,
  stageOf,
} from './earnings.util';

const repo = (qb: unknown) => ({ createQueryBuilder: jest.fn(() => qb) });

describe('earnings.util', () => {
  it.each([
    [PaymentStatus.PENDING, false, 'awaiting_payment'],
    [PaymentStatus.HELD, false, 'held'],
    [PaymentStatus.HELD, true, 'on_the_way'],
    [PaymentStatus.PENDING_TRANSFER, false, 'needs_action'],
    [PaymentStatus.TRANSFER_FAILED, true, 'needs_action'],
    [PaymentStatus.RELEASED, true, 'paid'],
    [PaymentStatus.REFUNDED, false, 'refunded'],
    [PaymentStatus.CANCELLED, false, 'not_paid'],
    [PaymentStatus.FAILED, false, 'not_paid'],
  ])('stageOf(%s, transfer %s) = %s', (status, started, stage) => {
    expect(stageOf(status, started)).toBe(stage);
  });

  it('names every stage in the SQL CASE too', () => {
    for (const stage of [
      'awaiting_payment',
      'on_the_way',
      'held',
      'needs_action',
      'paid',
      'refunded',
      'not_paid',
    ]) {
      expect(STAGE_SQL).toContain(`'${stage}'`);
    }
  });

  it('gives a failure reason only when money needs action', () => {
    expect(failureReasonOf(PaymentStatus.PENDING_TRANSFER)).toBe(
      'no_payout_method',
    );
    expect(failureReasonOf(PaymentStatus.TRANSFER_FAILED)).toBe(
      'transfer_failed',
    );
    expect(failureReasonOf(PaymentStatus.RELEASED)).toBeNull();
  });

  it('pays out only for counted stages', () => {
    expect(hasPayout('paid')).toBe(true);
    expect(hasPayout('held')).toBe(true);
    expect(hasPayout('refunded')).toBe(false);
    expect(hasPayout('awaiting_payment')).toBe(false);
  });

  it('names the client, or "Former client" when gone or blank', () => {
    expect(
      clientName({
        clientFirstname: 'Ama',
        clientLastname: 'Mensah',
        clientGone: false,
      }),
    ).toBe('Ama Mensah');
    expect(
      clientName({
        clientFirstname: 'Ama',
        clientLastname: 'Mensah',
        clientGone: true,
      }),
    ).toBe(FORMER_CLIENT);
    expect(
      clientName({
        clientFirstname: null,
        clientLastname: ' ',
        clientGone: false,
      }),
    ).toBe(FORMER_CLIENT);
  });

  it('resolves the profile from the caller id, 404 without one', async () => {
    const qb = qbMock({ getRawOne: { id: '7' } });
    await expect(resolveArtisanProfileId(repo(qb) as never, 3)).resolves.toBe(
      7,
    );
    expect(qb.params()).toEqual({ me: 3 });
    await expect(
      resolveArtisanProfileId(repo(qbMock()) as never, 3),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('reads balances as money strings, bound to the profile', async () => {
    const qb = qbMock({
      getRawOne: {
        held: '450',
        onTheWay: 300.5,
        needsAction: '120.10',
        needsActionCount: '1',
        paidThisMonth: null,
      },
    });
    const now = new Date('2026-10-31T10:00:00Z');
    await expect(queryBalances(repo(qb) as never, 7, now)).resolves.toEqual({
      heldForSignOff: '450.00',
      onTheWay: '300.50',
      needsAction: '120.10',
      needsActionCount: 1,
      paidThisMonth: '0.00',
    });
    expect(qb.params()).toMatchObject({ artisanProfileId: 7 });
    expect(qb.setParameter).toHaveBeenCalledWith(
      'monthStart',
      new Date('2026-10-01T00:00:00Z'),
    );
  });

  it('reads an empty ledger as zeroes', async () => {
    await expect(
      queryBalances(repo(qbMock()) as never, 7, new Date()),
    ).resolves.toMatchObject({ heldForSignOff: '0.00', needsActionCount: 0 });
  });
});
