/**
 * QA re-verification for `docs/team/auth-residual-findings/requirements.md`
 * item 3 (security `M3`): the purge must also clear a customer's free-text bio
 * and delete every registered push device.
 *
 * Test code only — written by QA. Nothing here is imported by the application.
 *
 * This re-runs the ORIGINAL M3 repro: a real destructive purge over a real
 * fixture, read back from the database with a raw `select` — never from the
 * purge's own return value and never through a mocked repository.
 *
 * Run: npm run test:e2e -- auth-residual-r4-purge.qa
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { subDays } from 'date-fns';
import { AppModule } from '../src/app.module';
import { User } from '@users/entities/user.entity';
import { CustomerProfile } from '@users/entities/customer-profile.entity';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { AccountPurgeService } from '@users/account-purge.service';
import { Role, DevicePlatform } from '@common/types/enums';
import { VARIABLES } from '@common/constants/variables.constants';

jest.setTimeout(300000);

const PASSWORD = 'CorrectHorse1!';
const BIO = 'QA R4 bio: I live in Osu, Accra and I mostly need plumbing help.';

describe('auth-residual-findings item 3 — purge clears customer bio + device tokens (QA e2e)', () => {
  let moduleFixture: TestingModule;
  let userRepo: Repository<User>;
  let customerProfileRepo: Repository<CustomerProfile>;
  let artisanProfileRepo: Repository<ArtisanProfile>;
  let purgeService: AccountPurgeService;

  const uniq = Date.now();
  const createdUserIds: number[] = [];
  const createdCustomerProfileIds: number[] = [];
  const createdArtisanProfileIds: number[] = [];

  /** The mode value the environment came with, restored in afterAll. */
  let originalMode: string | undefined;

  function setMode(value: string | undefined): void {
    if (value === undefined) delete process.env.ACCOUNT_PURGE_MODE;
    else process.env.ACCOUNT_PURGE_MODE = value;
  }

  /** Reads the two things M3 is about straight out of the database. */
  async function readBack(userId: number): Promise<{
    bio: string | null;
    bioExists: boolean;
    deviceTokens: number;
    purgedAt: string | null;
  }> {
    const bioRows: { bio: string | null }[] = await userRepo.manager.query(
      'select bio from customer_profiles where user_id = $1',
      [userId],
    );
    const dt: { c: number }[] = await userRepo.manager.query(
      'select count(*)::int c from device_tokens where user_id = $1',
      [userId],
    );
    const u: { purged_at: string | null }[] = await userRepo.manager.query(
      'select purged_at from users where id = $1',
      [userId],
    );
    return {
      bio: bioRows[0]?.bio ?? null,
      bioExists: bioRows.length > 0,
      deviceTokens: dt[0].c,
      purgedAt: u[0]?.purged_at ?? null,
    };
  }

  /** A soft-deleted, past-cutoff CUSTOMER with a bio and two device tokens. */
  async function makePurgeableCustomer(label: string): Promise<number> {
    const user = await userRepo.save(
      userRepo.create({
        email: `qa-r4p-${label}-${uniq}@test.jinva.local`,
        password: await bcrypt.hash(PASSWORD, VARIABLES.SALT_OR_ROUNDS),
        firstname: 'QaR4p',
        lastname: label.slice(0, 14),
        role: Role.CUSTOMER,
        accountVerified: true,
      } as Partial<User>),
    );
    createdUserIds.push(user.id);

    const prof = await customerProfileRepo.save(
      customerProfileRepo.create({
        user,
        bio: BIO,
      } as Partial<CustomerProfile>),
    );
    createdCustomerProfileIds.push(prof.id);

    for (const n of [1, 2]) {
      await userRepo.manager.query(
        `insert into device_tokens (user_id, token, platform, created_at, updated_at)
         values ($1, $2, $3, now(), now())`,
        [user.id, `qa-r4p-${label}-${uniq}-token-${n}`, DevicePlatform.ANDROID],
      );
    }

    // Soft-deleted well past the 30-day cutoff, so it is a genuine candidate.
    await userRepo.manager.query(
      'update users set deleted_at = $2 where id = $1',
      [user.id, subDays(new Date(), 45)],
    );
    return user.id;
  }

  beforeAll(async () => {
    originalMode = process.env.ACCOUNT_PURGE_MODE;
    moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    await moduleFixture.init();

    userRepo = moduleFixture.get(getRepositoryToken(User));
    customerProfileRepo = moduleFixture.get(
      getRepositoryToken(CustomerProfile),
    );
    artisanProfileRepo = moduleFixture.get(getRepositoryToken(ArtisanProfile));
    purgeService = moduleFixture.get(AccountPurgeService);
  });

  afterAll(async () => {
    setMode(originalMode);
    for (const id of createdUserIds) {
      await userRepo.manager
        .query('delete from device_tokens where user_id = $1', [id])
        .catch(() => undefined);
      await userRepo.manager
        .query('delete from user_tokens where user_id = $1', [id])
        .catch(() => undefined);
    }
    if (createdCustomerProfileIds.length)
      await customerProfileRepo
        .delete(createdCustomerProfileIds)
        .catch(() => undefined);
    if (createdArtisanProfileIds.length)
      await artisanProfileRepo
        .delete(createdArtisanProfileIds)
        .catch(() => undefined);
    if (createdUserIds.length)
      await userRepo.manager
        .query('delete from users where id = any($1::int[])', [createdUserIds])
        .catch(() => undefined);
    await moduleFixture.close();
  });

  it('sanity: the mode switch this file relies on actually reaches the service', () => {
    setMode('destructive');
    const armed = purgeService.isDestructiveModeEnabled();
    setMode('log-only');
    const disarmed = purgeService.isDestructiveModeEnabled();
    console.log('[item3] mode switch destructive/log-only =', armed, disarmed);
    expect(armed).toBe(true);
    expect(disarmed).toBe(false);
  });

  it('M3 original repro: a LIVE destructive purge nulls customer_profiles.bio and deletes every device_tokens row', async () => {
    setMode('destructive');
    const id = await makePurgeableCustomer('destructive');

    const before = await readBack(id);
    console.log('[item3] destructive BEFORE =', JSON.stringify(before));
    expect(before.bio).toBe(BIO);
    expect(before.deviceTokens).toBe(2);

    const outcome = await purgeService.purgeAccount(id);
    console.log('[item3] purge outcome =', outcome);
    expect(outcome).toBe('purged');

    // Read back from the database, not from the purge response.
    const after = await readBack(id);
    console.log('[item3] destructive AFTER =', JSON.stringify(after));
    expect(after.bio).toBeNull();
    // The profile row itself is deliberately kept (bookings/jobs join it).
    expect(after.bioExists).toBe(true);
    expect(after.deviceTokens).toBe(0);
    expect(after.purgedAt).toBeTruthy();
  });

  it('a rerun on the same id returns "skipped" and rewrites nothing', async () => {
    setMode('destructive');
    const id = await makePurgeableCustomer('rerun');
    expect(await purgeService.purgeAccount(id)).toBe('purged');
    const afterFirst = await readBack(id);

    const second = await purgeService.purgeAccount(id);
    console.log('[item3] rerun outcome =', second);
    expect(second).toBe('skipped');
    const afterSecond = await readBack(id);
    console.log(
      '[item3] rerun purgedAt unchanged =',
      afterFirst.purgedAt === afterSecond.purgedAt,
    );
    expect(afterSecond).toEqual(afterFirst);
  });

  it('log-only mode (the default) leaves the bio and every device token completely untouched', async () => {
    setMode('log-only');
    const id = await makePurgeableCustomer('logonly');

    const outcome = await purgeService.purgeAccount(id);
    console.log('[item3] log-only outcome =', outcome);
    expect(outcome).toBe('reported');

    const after = await readBack(id);
    console.log('[item3] log-only AFTER =', JSON.stringify(after));
    expect(after.bio).toBe(BIO);
    expect(after.deviceTokens).toBe(2);
    expect(after.purgedAt).toBeNull();
  });

  it("a typo'd or unset ACCOUNT_PURGE_MODE is inert for the two new steps as well", async () => {
    for (const value of ['true', '1', 'yes', 'DESTROY', '', undefined]) {
      setMode(value);
      const armed = purgeService.isDestructiveModeEnabled();
      console.log(`[item3] mode=${JSON.stringify(value)} destructive=${armed}`);
      expect(armed).toBe(false);

      const id = await makePurgeableCustomer(
        `typo-${String(value).replace(/\W/g, '') || 'empty'}`,
      );
      const outcome = await purgeService.purgeAccount(id);
      expect(outcome).toBe('reported');
      const after = await readBack(id);
      expect(after.bio).toBe(BIO);
      expect(after.deviceTokens).toBe(2);
      expect(after.purgedAt).toBeNull();
    }
  });

  it('empty states purge cleanly: an ARTISAN with no customer profile, and an account with no registered devices', async () => {
    setMode('destructive');

    // (a) ARTISAN, no customer_profiles row at all.
    const artisan = await userRepo.save(
      userRepo.create({
        email: `qa-r4p-artisan-${uniq}@test.jinva.local`,
        password: await bcrypt.hash(PASSWORD, VARIABLES.SALT_OR_ROUNDS),
        firstname: 'QaR4p',
        lastname: 'Artisan',
        role: Role.ARTISAN,
        accountVerified: true,
      } as Partial<User>),
    );
    createdUserIds.push(artisan.id);
    const ap = await artisanProfileRepo.save(
      artisanProfileRepo.create({ user: artisan } as Partial<ArtisanProfile>),
    );
    createdArtisanProfileIds.push(ap.id);
    await userRepo.manager.query(
      'update users set deleted_at = $2 where id = $1',
      [artisan.id, subDays(new Date(), 45)],
    );
    const aOutcome = await purgeService.purgeAccount(artisan.id);
    const aAfter = await readBack(artisan.id);
    console.log(
      '[item3] artisan-no-customer-profile =',
      aOutcome,
      JSON.stringify(aAfter),
    );
    expect(aOutcome).toBe('purged');
    expect(aAfter.bioExists).toBe(false);
    expect(aAfter.deviceTokens).toBe(0);

    // (b) CUSTOMER with a profile but no bio and no device tokens.
    const bare = await userRepo.save(
      userRepo.create({
        email: `qa-r4p-bare-${uniq}@test.jinva.local`,
        password: await bcrypt.hash(PASSWORD, VARIABLES.SALT_OR_ROUNDS),
        firstname: 'QaR4p',
        lastname: 'Bare',
        role: Role.CUSTOMER,
        accountVerified: true,
      } as Partial<User>),
    );
    createdUserIds.push(bare.id);
    const bp = await customerProfileRepo.save(
      customerProfileRepo.create({ user: bare } as Partial<CustomerProfile>),
    );
    createdCustomerProfileIds.push(bp.id);
    await userRepo.manager.query(
      'update users set deleted_at = $2 where id = $1',
      [bare.id, subDays(new Date(), 45)],
    );
    const bOutcome = await purgeService.purgeAccount(bare.id);
    const bAfter = await readBack(bare.id);
    console.log(
      '[item3] no-bio-no-devices =',
      bOutcome,
      JSON.stringify(bAfter),
    );
    expect(bOutcome).toBe('purged');
    expect(bAfter.bio).toBeNull();
    expect(bAfter.deviceTokens).toBe(0);
    expect(bAfter.purgedAt).toBeTruthy();
  });

  it('a live (never-deleted) account with a bio and devices is never touched by a destructive run', async () => {
    setMode('destructive');
    const user = await userRepo.save(
      userRepo.create({
        email: `qa-r4p-live-${uniq}@test.jinva.local`,
        password: await bcrypt.hash(PASSWORD, VARIABLES.SALT_OR_ROUNDS),
        firstname: 'QaR4p',
        lastname: 'Live',
        role: Role.CUSTOMER,
        accountVerified: true,
      } as Partial<User>),
    );
    createdUserIds.push(user.id);
    const prof = await customerProfileRepo.save(
      customerProfileRepo.create({
        user,
        bio: BIO,
      } as Partial<CustomerProfile>),
    );
    createdCustomerProfileIds.push(prof.id);
    await userRepo.manager.query(
      `insert into device_tokens (user_id, token, platform, created_at, updated_at)
       values ($1, $2, $3, now(), now())`,
      [user.id, `qa-r4p-live-${uniq}-token`, DevicePlatform.ANDROID],
    );

    const outcome = await purgeService.purgeAccount(user.id);
    const after = await readBack(user.id);
    console.log('[item3] live account =', outcome, JSON.stringify(after));
    expect(outcome).toBe('skipped');
    expect(after.bio).toBe(BIO);
    expect(after.deviceTokens).toBe(1);
  });

  it('an account still inside the 30-day window is never touched by a destructive run', async () => {
    setMode('destructive');
    const id = await makePurgeableCustomer('inwindow');
    await userRepo.manager.query(
      'update users set deleted_at = $2 where id = $1',
      [id, subDays(new Date(), 3)],
    );
    const outcome = await purgeService.purgeAccount(id);
    const after = await readBack(id);
    console.log('[item3] inside window =', outcome, JSON.stringify(after));
    expect(outcome).toBe('skipped');
    expect(after.bio).toBe(BIO);
    expect(after.deviceTokens).toBe(2);
  });
});
