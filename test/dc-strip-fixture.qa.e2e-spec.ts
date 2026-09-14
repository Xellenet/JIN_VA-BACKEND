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
import { Dispute } from '../src/disputes/entities/dispute.entity';
import {
  BookingStatus,
  DisputeCategory,
  DisputeStatus,
  Role,
  Status,
} from '@common/types/enums';

/**
 * QA browser-fixture builder for DC3.6 — **not an assertion spec.**
 *
 * Two states the job/booking dispute strip has to get right and which the dev
 * database does not currently contain:
 *
 *   A. one dispute, filed by the client, unanswered — so the **artisan** is a
 *      counterparty who still owes a response. The strip on their job must read
 *      "Dispute" / "View dispute" with the emphasised "Your response is
 *      needed", never "Your report".
 *   B. **both** parties filed on the same booking. `GET /disputes/my` then
 *      returns two rows with the same `booking.id` to both of them, which is
 *      the case a bare `.find()` got wrong: array order could send a viewer to
 *      the other party's dispute. Each viewer's strip must resolve to the
 *      dispute *they* raised.
 *
 * Run: npm run test:e2e -- dc-strip-fixture
 */
jest.setTimeout(120000);

describe('QA DC3.6 strip fixture (setup only)', () => {
  let app: INestApplication;

  it('creates the counterparty-owes-response and both-parties-filed states', async () => {
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

    async function makeChain(label: string, price: number) {
      const booking = await bookingRepo.save(
        bookingRepo.create({
          customer,
          artisanProfile,
          service,
          scheduledDate: '2026-09-03',
          startTime: '13:00:00',
          endTime: '15:00:00',
          status: BookingStatus.COMPLETED,
          agreedPrice: price,
          currency: 'GHS',
        }),
      );
      const job = await jobRepo.save(
        jobRepo.create({
          customer,
          service,
          title: `QA DC3.6 ${label} — booking #${booking.id}`,
          description: 'Fixture for the job/booking dispute strip.',
          location: 'Osu, Accra',
          currency: 'GHS',
          budgetMin: price,
          budgetMax: price,
          status: Status.COMPLETED,
          acceptedArtisan: artisanUser,
          booking,
        }),
      );
      return { booking, job };
    }

    function disputeFrom(
      booking: Booking,
      raiser: User,
      reason: string,
      cat: DisputeCategory,
    ) {
      return disputeRepo.save(
        disputeRepo.create({
          booking,
          bookingId: booking.id,
          raisedBy: raiser,
          raisedById: raiser.id,
          category: cat,
          status: DisputeStatus.OPEN,
          reason,
          createdAt: new Date(),
        }),
      );
    }

    // A. client filed, artisan owes a response.
    const a = await makeChain('COUNTERPARTY', 300);
    const aDispute = await disputeFrom(
      a.booking,
      customer,
      'The tiling in the bathroom was left unfinished and the grout was never applied, ' +
        'so the room cannot be used yet.',
      DisputeCategory.WORK_NOT_COMPLETED,
    );

    // B. both parties filed on one booking. The client's is created FIRST, so
    // `createdAt DESC` puts the ARTISAN's row first in GET /disputes/my — which
    // is exactly the ordering that made a bare .find() hand the client the
    // artisan's dispute.
    const b = await makeChain('BOTHFILED', 400);
    const bClient = await disputeFrom(
      b.booking,
      customer,
      'Half the fittings I paid for were never installed and the artisan stopped replying ' +
        'once the payment went through.',
      DisputeCategory.WORK_NOT_COMPLETED,
    );
    await new Promise((r) => setTimeout(r, 1200));
    const bArtisan = await disputeFrom(
      b.booking,
      artisanUser,
      'I installed everything on the agreed list. The extra fittings the client is describing ' +
        'were never part of what we priced.',
      DisputeCategory.PAYMENT_AMOUNT,
    );

    console.log(
      '\n[QA-DC36-FIXTURE] ' +
        JSON.stringify(
          {
            counterpartyCase: {
              bookingId: a.booking.id,
              jobId: a.job.id,
              disputeId: aDispute.id,
            },
            bothFiledCase: {
              bookingId: b.booking.id,
              jobId: b.job.id,
              clientDisputeId: bClient.id,
              artisanDisputeId: bArtisan.id,
            },
          },
          null,
          1,
        ),
    );

    expect(aDispute.id).toBeGreaterThan(0);
    await app.close();
  });
});
