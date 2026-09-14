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
  DisputeStatus,
  PaymentStatus,
  Role,
  Status,
} from '@common/types/enums';

/**
 * QA browser-fixture builder — **not an assertion spec.**
 *
 * The manual browser pass for DC1/DC3 needs states the dev database does not
 * contain: every dispute on it is already terminal, and no booking-derived job
 * carries a `HELD` payment (booking-derived jobs never get a payment hold — a
 * known, separately-deferred gap), so neither money verdict can be exercised
 * through the UI as seeded.
 *
 * This builds those states between two **existing seeded users**, so the
 * browser can sign in with the ordinary seed password rather than needing new
 * credentials:
 *
 *   customer : abena.boateng@gmail.com
 *   artisan  : efua.agyeman@jinva.com
 *
 * It creates, and deliberately does **not** clean up (the browser pass runs
 * after it; `dc-browser-teardown` removes it afterwards):
 *
 *   A. a COMPLETED booking + booking-derived job + `HELD` payment (GH₵ 240)
 *      with an OPEN dispute raised by the customer — the DC1 case where both
 *      money verdicts are genuinely available and the artisan is a
 *      counterparty who still owes a response (DC3.4).
 *   B. a COMPLETED booking with **no** payment and an OPEN dispute — the DC1.2
 *      steady state where both money verdicts must be disabled with the
 *      server's own reason.
 *
 * Run: npm run test:e2e -- dc-browser-fixture
 */
jest.setTimeout(120000);

describe('QA browser fixture (setup only)', () => {
  let app: INestApplication;

  it('creates the DC1/DC3 browser states and prints their ids', async () => {
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
    const artisanProfile = await profileRepo.findOneOrFail({
      where: { user: { id: artisanUser.id } },
    });
    const service = await serviceRepo.findOneOrFail({
      where: {},
      order: { id: 'ASC' },
    });

    async function chain(
      label: string,
      price: number,
      withPayment: boolean,
    ): Promise<{ bookingId: number; disputeId: number; paymentId?: number }> {
      const booking = await bookingRepo.save(
        bookingRepo.create({
          customer,
          artisanProfile,
          service,
          scheduledDate: '2026-09-01',
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
          title: `QA browser fixture ${label} — booking #${booking.id}`,
          description:
            'Fixture created by QA so the dispute resolve flow can be driven in a browser.',
          location: 'East Legon, Accra',
          currency: 'GHS',
          budgetMin: price,
          budgetMax: price,
          status: Status.COMPLETED,
          acceptedArtisan: artisanUser,
          booking,
        }),
      );

      let paymentId: number | undefined;
      if (withPayment) {
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
            status: PaymentStatus.HELD,
            reference: `qa-browser-${label}-${Date.now()}`,
            channel: 'mobile_money',
            paidAt: new Date('2026-09-02T10:00:00Z'),
          }),
        );
        paymentId = payment.id;
      }

      const dispute = await disputeRepo.save(
        disputeRepo.create({
          booking,
          bookingId: booking.id,
          raisedBy: customer,
          raisedById: customer.id,
          category: DisputeCategory.WORK_QUALITY,
          status: DisputeStatus.OPEN,
          reason:
            'The finish was uneven in two rooms and one socket was left loose. ' +
            'I would like part of what I paid returned so I can have it corrected.',
        }),
      );

      return { bookingId: booking.id, disputeId: dispute.id, paymentId };
    }

    const withPay = await chain('HELD', 240, true);
    const noPay = await chain('NOPAY', 120, false);

    console.log(
      '\n[QA-FIXTURE] ' +
        JSON.stringify(
          {
            customerEmail: customer.email,
            artisanEmail: artisanUser.email,
            withPayment: withPay,
            noPayment: noPay,
          },
          null,
          1,
        ),
    );

    expect(withPay.disputeId).toBeGreaterThan(0);
    expect(noPay.disputeId).toBeGreaterThan(0);
    await app.close();
  });
});
