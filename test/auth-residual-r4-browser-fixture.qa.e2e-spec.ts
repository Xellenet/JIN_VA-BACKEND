/**
 * QA browser-fixture builder for `docs/team/auth-residual-findings` — **not an
 * assertion spec.** Test code only; nothing here is imported by the app.
 *
 * The manual browser pass for items 2, 4, 7 and 10 needs states the dev
 * database does not contain: an artisan whose *only* remaining profile gap is
 * `services`, one with more than one gap, one already complete, a pair whose
 * phone numbers collide, a disposable account to delete, and a soft-deleted
 * account inside its window to restore.
 *
 * Addresses are deterministic (no timestamp) so the browser harness can sign
 * in without being told them, and the builder is idempotent — it deletes any
 * previous run's fixtures first.
 *
 * Password for every fixture: the dev seed password, so the browser pass can
 * type the same one it uses for seeded accounts.
 *
 * Run:  npm run test:e2e -- auth-residual-r4-browser-fixture
 * Then: npm run test:e2e -- auth-residual-r4-browser-fixture  (to rebuild)
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { subDays } from 'date-fns';
import { AppModule } from '../src/app.module';
import { User } from '@users/entities/user.entity';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { ServiceEntity } from '@services/entities/service.entity';
import { Role } from '@common/types/enums';
import { VARIABLES } from '@common/constants/variables.constants';

jest.setTimeout(300000);

const PASSWORD = 'Seed@1234';
const DOMAIN = 'test.jinva.local';
const addr = (label: string) => `qa-r4b-${label}@${DOMAIN}`;

/** Deterministic, obviously-fake Ghana numbers that no seeded row uses. */
const PHONE = {
  artGap: '024-990-0001',
  artMulti: '024-990-0002',
  artComplete: '024-990-0003',
  artSave: '024-990-0004',
  phoneHolder: '024-990-0005',
  cust: '024-990-0006',
  custDelete: '024-990-0007',
  custDeleted: '024-990-0008',
};

describe('QA browser fixture for auth-residual-findings (setup only)', () => {
  let app: INestApplication;
  let userRepo: Repository<User>;
  let profileRepo: Repository<ArtisanProfile>;
  let serviceRepo: Repository<ServiceEntity>;

  it('creates the item 2/4/7/10 browser states and prints them', async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();

    userRepo = moduleFixture.get(getRepositoryToken(User));
    profileRepo = moduleFixture.get(getRepositoryToken(ArtisanProfile));
    serviceRepo = moduleFixture.get(getRepositoryToken(ServiceEntity));

    // ── idempotent teardown of any previous run ────────────────────────────
    const previous: { id: number }[] = await userRepo.manager.query(
      `select id from users where email like 'qa-r4b-%@${DOMAIN}'`,
    );
    for (const p of previous) {
      await userRepo.manager.query(
        'delete from artisan_profile_services where artisan_profile_id in (select id from artisan_profiles where user_id = $1)',
        [p.id],
      );
      await userRepo.manager.query(
        'delete from artisan_profiles where user_id = $1',
        [p.id],
      );
      await userRepo.manager.query(
        'delete from customer_profiles where user_id = $1',
        [p.id],
      );
      await userRepo.manager.query(
        'delete from device_tokens where user_id = $1',
        [p.id],
      );
      await userRepo.manager.query(
        'delete from user_tokens where user_id = $1',
        [p.id],
      );
    }
    if (previous.length)
      await userRepo.manager.query(
        'delete from users where id = any($1::int[])',
        [previous.map((p) => p.id)],
      );
    console.log('[fixture] removed previous fixtures =', previous.length);

    const hashed = await bcrypt.hash(PASSWORD, VARIABLES.SALT_OR_ROUNDS);

    const make = async (
      label: string,
      role: Role,
      phone: string,
      extra: Partial<User> = {},
    ): Promise<User> => {
      const u = await userRepo.save(
        userRepo.create({
          email: addr(label),
          password: hashed,
          username: `qar4b${label.replace(/-/g, '')}`,
          firstname: 'Kwabena',
          lastname: label.slice(0, 14),
          phoneNumber: phone,
          role,
          accountVerified: true,
          isBanned: false,
          isSuspended: false,
          ...extra,
        } as Partial<User>),
      );
      return u;
    };

    // A real seeded service to attach, so the artisan is genuinely searchable.
    const someService = await serviceRepo.findOne({
      where: {},
      order: { id: 'ASC' },
    });
    if (!someService)
      throw new Error('no services seeded — cannot build fixtures');

    // ── A. artisan whose ONLY gap is `services` (item 10 last-gap case) ────
    const artGap = await make('art-gap', Role.ARTISAN, PHONE.artGap);
    await profileRepo.save(
      profileRepo.create({
        user: artGap,
        bio: 'Carpenter in Accra with ten years of bespoke furniture work.',
        hourlyRate: 85,
        location: 'Accra',
        businessName: 'Gap Carpentry',
        currency: 'GHS',
        services: [],
      } as unknown as Partial<ArtisanProfile>),
    );

    // ── B. artisan with MORE than one gap (item 10 suppression case) ───────
    const artMulti = await make('art-multi', Role.ARTISAN, PHONE.artMulti);
    await profileRepo.save(
      profileRepo.create({
        user: artMulti,
        // no bio, no hourlyRate, no services → 3 gaps; adding a service leaves 2
        location: 'Kumasi',
        businessName: 'Multi Gap Works',
        currency: 'GHS',
        services: [],
      } as unknown as Partial<ArtisanProfile>),
    );

    // ── C. artisan ALREADY complete (item 10 suppression case) ─────────────
    const artComplete = await make(
      'art-complete',
      Role.ARTISAN,
      PHONE.artComplete,
    );
    await profileRepo.save(
      profileRepo.create({
        user: artComplete,
        bio: 'Electrician covering Accra and Tema, fully certified.',
        hourlyRate: 120,
        location: 'Tema',
        businessName: 'Complete Electrics',
        currency: 'GHS',
        services: [someService],
        // Round 3: set explicitly. A direct repository insert never runs the
        // service's completeness recompute, so this row sat with all four
        // fields present and the stored flag still `false` — OBS-1's
        // "unknown" state, not the "already complete" state this fixture is
        // named for. That also tripped `account-closeout.qa`'s C2.2
        // stale-false backfill sweep, which scans the whole table.
        isProfileComplete: true,
      } as unknown as Partial<ArtisanProfile>),
    );

    // ── D/E. item 7: an artisan to save, and a holder of the phone number
    //        the save will collide with.
    const artSave = await make('art-save', Role.ARTISAN, PHONE.artSave);
    await profileRepo.save(
      profileRepo.create({
        user: artSave,
        bio: 'Plumber serving Osu and Labone, emergency callouts welcome.',
        hourlyRate: 95,
        location: 'Osu',
        businessName: 'Save Plumbing',
        currency: 'GHS',
        services: [someService],
      } as unknown as Partial<ArtisanProfile>),
    );
    await make('phone-holder', Role.CUSTOMER, PHONE.phoneHolder);

    // ── F/G/H. customers ──────────────────────────────────────────────────
    await make('cust', Role.CUSTOMER, PHONE.cust);
    await make('cust-delete', Role.CUSTOMER, PHONE.custDelete);
    const custDeleted = await make(
      'cust-deleted',
      Role.CUSTOMER,
      PHONE.custDeleted,
    );
    await userRepo.manager.query(
      'update users set deleted_at = $2 where id = $1',
      [custDeleted.id, subDays(new Date(), 3)],
    );

    const rows: Record<string, unknown>[] = await userRepo.manager.query(
      `select u.id, u.email, u.role, u.phone_number, u.deleted_at,
              p.is_profile_complete,
              (select count(*)::int from artisan_profile_services s where s.artisan_profile_id = p.id) as services,
              (p.bio is not null) as has_bio, p.hourly_rate, p.location
         from users u
         left join artisan_profiles p on p.user_id = u.id
        where u.email like 'qa-r4b-%@${DOMAIN}'
        order by u.email`,
    );
    // The value itself is deliberately not printed — it is the dev seed
    // password and the suite log gets pasted into reports.
    console.log(
      '[fixture] password for all fixtures = the dev seed password (see PASSWORD in this file)',
    );
    console.log('[fixture] created:');
    console.log(JSON.stringify(rows, null, 1));
    await app.close();
    expect(rows.length).toBe(8);
  });
});
