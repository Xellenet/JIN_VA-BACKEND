import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { User } from '@users/entities/user.entity';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { ServiceEntity } from '@services/entities/service.entity';
import { Booking } from '../src/bookings/entities/booking.entity';
import { Job } from '@jobs/entities/job.entity';
import { Payment } from '../src/payments/entities/payment.entity';
import { Dispute } from '../src/disputes/entities/dispute.entity';
import {
  BookingStatus,
  DisputeCategory,
  DisputeMoneyAction,
  DisputeOutcome,
  DisputeStatus,
  PaymentStatus,
  Role,
  Status,
} from '@common/types/enums';

/**
 * QA browser-fixture builder for DC3.5 — **not an assertion spec.**
 *
 * DC3.5 specifies five exact money lines, worded from the reader's own side.
 * Four of the five can only render on a dispute whose `moneyAction` is `REFUND`
 * or `RELEASE` — and **no dispute on this platform has ever had one**: every
 * row reads `moneyAction` `NONE` or `null`, because a real money verdict has to
 * clear `PaystackService`, which a synthetic payment reference cannot.
 *
 * So the reader-side copy has never been rendered with real data. These two
 * rows represent the exact committed state a successful ruling produces (the
 * state my `dc-closeout` spec proves the resolve path actually writes, with the
 * gateway stubbed), so the party page can be driven in a real browser for both
 * sides of both directions.
 *
 * Run: npm run test:e2e -- dc-outcome-fixture
 */
jest.setTimeout(120000);

describe('QA DC3.5 outcome fixture (setup only)', () => {
  let app: INestApplication;

  it('creates a refunded and a released resolved dispute, and prints their ids', async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();

    const userRepo: Repository<User> = moduleFixture.get(
      getRepositoryToken(User),
    );
    const profileRepo: Repository<ArtisanProfile> = moduleFixture.get(
      getRepositoryToken(ArtisanProfile),
    );
    const serviceRepo: Repository<ServiceEntity> = moduleFixture.get(
      getRepositoryToken(ServiceEntity),
    );
    const bookingRepo: Repository<Booking> = moduleFixture.get(
      getRepositoryToken(Booking),
    );
    const jobRepo: Repository<Job> = moduleFixture.get(getRepositoryToken(Job));
    const paymentRepo: Repository<Payment> = moduleFixture.get(
      getRepositoryToken(Payment),
    );
    const disputeRepo: Repository<Dispute> = moduleFixture.get(
      getRepositoryToken(Dispute),
    );

    const customer = await userRepo.findOneByOrFail({
      email: 'abena.boateng@gmail.com',
      role: Role.CUSTOMER,
    });
    const artisanUser = await userRepo.findOneByOrFail({
      email: 'efua.agyeman@jinva.com',
      role: Role.ARTISAN,
    });
    const admin = await userRepo.findOneByOrFail({
      email: 'admin@jinva.com',
      role: Role.ADMIN,
    });
    const artisanProfile = await profileRepo.findOneOrFail({
      where: { user: { id: artisanUser.id } },
    });
    const service = await serviceRepo.findOneOrFail({
      where: {},
      order: { id: 'ASC' },
    });

    async function resolved(
      label: string,
      price: number,
      action: DisputeMoneyAction,
      outcome: DisputeOutcome,
      paymentStatus: PaymentStatus,
      refundedAmount: number,
      moneyAmount: number,
    ) {
      const booking = await bookingRepo.save(
        bookingRepo.create({
          customer,
          artisanProfile,
          service,
          scheduledDate: '2026-08-20',
          startTime: '09:00:00',
          endTime: '11:00:00',
          status: BookingStatus.COMPLETED,
          agreedPrice: price,
          currency: 'GHS',
        }),
      );
      const job = await jobRepo.save(
        jobRepo.create({
          customer,
          service,
          title: `QA DC3.5 ${label} — booking #${booking.id}`,
          description:
            'Fixture representing a ruled dispute after money moved.',
          location: 'East Legon, Accra',
          currency: 'GHS',
          budgetMin: price,
          budgetMax: price,
          status: Status.COMPLETED,
          acceptedArtisan: artisanUser,
          booking,
        }),
      );
      const platformFee = +(price * 0.05).toFixed(2);
      const payment = await paymentRepo.save(
        paymentRepo.create({
          jobId: job.id,
          customerId: customer.id,
          artisanProfileId: artisanProfile.id,
          amount: price,
          platformFee,
          artisanAmount: +(price - platformFee).toFixed(2),
          currency: 'GHS',
          status: paymentStatus,
          refundedAmount,
          reference: `qa-dc35-${label}-${Date.now()}`,
          channel: 'mobile_money',
          paidAt: new Date('2026-08-21T10:00:00Z'),
        }),
      );
      const dispute = await disputeRepo.save(
        disputeRepo.create({
          booking,
          bookingId: booking.id,
          raisedBy: customer,
          raisedById: customer.id,
          category: DisputeCategory.WORK_NOT_COMPLETED,
          status: DisputeStatus.RESOLVED,
          reason:
            'The artisan stopped after the first room and did not return to finish the other two, ' +
            'so most of the job I paid for was never done.',
          outcome,
          resolution:
            'Reviewed both accounts and the job record. The work was demonstrably incomplete, ' +
            'so this is decided in the client’s favour.',
          resolvedById: admin.id,
          resolvedAt: new Date('2026-09-05T14:20:00Z'),
          moneyAction: action,
          moneyAmount,
          moneyPaymentId: payment.id,
        }),
      );
      return {
        bookingId: booking.id,
        disputeId: dispute.id,
        paymentId: payment.id,
      };
    }

    const refunded = await resolved(
      'REFUND',
      240,
      DisputeMoneyAction.REFUND,
      DisputeOutcome.REFUND_CLIENT,
      PaymentStatus.REFUNDED,
      240,
      240,
    );
    const released = await resolved(
      'RELEASE',
      180,
      DisputeMoneyAction.RELEASE,
      DisputeOutcome.RELEASE_ARTISAN,
      PaymentStatus.RELEASED,
      0,
      171,
    );

    console.log(
      '\n[QA-DC35-FIXTURE] ' + JSON.stringify({ refunded, released }, null, 1),
    );

    expect(refunded.disputeId).toBeGreaterThan(0);
    expect(released.disputeId).toBeGreaterThan(0);
    await app.close();
  });
});
