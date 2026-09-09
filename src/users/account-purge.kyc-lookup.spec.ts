import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { FindManyOptions, SelectQueryBuilder } from 'typeorm';
import { subDays } from 'date-fns';
import { AccountPurgeService } from './account-purge.service';
import { User } from './entities/user.entity';
import { ArtisanVerification } from '../verification/entities/artisan-verification.entity';
import { KycMediaService } from '../uploads/kyc-media.service';
import { VARIABLES } from '@common/constants/variables.constants';
import { Role } from '@common/types/enums';

/**
 * The KYC purge step (C1.7) asserted against the **SQL it actually emits**,
 * rather than against a hand-fed mock.
 *
 * This spec exists because the first version of `scrubArtisanVerifications`
 * shipped as a silent no-op with five passing unit tests behind it. It looked
 * its rows up with `find({ where: { artisanProfile: { user: { id } } } })`, and
 * TypeORM appends `AND users.deleted_at IS NULL` to the LEFT JOIN it builds for
 * that relation condition. Every purge candidate is soft-deleted by definition,
 * so the join could never match: the lookup returned zero rows on every purge
 * and the step returned before deleting a document or clearing a column.
 * `account-purge.service.spec.ts` mocks the verification repository, so all five
 * assertions ran downstream of a lookup that was structurally unable to match —
 * the mocked-repository style cannot see this class of defect at all.
 *
 * So here the repository double compiles whatever query the service builds
 * through **real** entity metadata and the real query builder, and the
 * assertions are on the resulting SQL. No database is involved: the `DataSource`
 * is never initialized, only its metadata is built, and nothing is executed.
 * The double accepts either API (`find` or `createQueryBuilder`), so the
 * assertions hold however the lookup is expressed and would have failed on the
 * original defect.
 */
describe('AccountPurgeService — the KYC lookup it actually sends (security H1)', () => {
  /** Metadata only — `initialize()` is never called, so no connection opens. */
  let dataSource: DataSource;

  type CompiledQuery = { sql: string; parameters: unknown[] };

  const deletedUser = {
    id: 7,
    role: Role.ARTISAN,
    email: 'gone@example.com',
    deletedAt: subDays(new Date(), 45),
    purgedAt: null,
  };

  const verificationRow = {
    id: 55,
    artisanProfileId: 91,
    idNumber: 'GHA-000111222-3',
    fullLegalName: 'Yaw Mensah',
    documentFrontUrl: '/uploads/documents/front-uuid.jpg',
    documentBackUrl: '/uploads/documents/back-uuid.jpg',
    selfieUrl: '/uploads/selfies/selfie-uuid.jpg',
  } as unknown as ArtisanVerification;

  let service: AccountPurgeService;
  /** Every query the KYC step sent, compiled to SQL by real TypeORM. */
  let sent: CompiledQuery[];

  const usersRepoDouble = {
    findOne: jest.fn(),
    update: jest.fn(),
  };
  const kycMedia = { deleteByReference: jest.fn() };
  const verificationUpdate = jest.fn();

  const compile = (qb: SelectQueryBuilder<ArtisanVerification>) => {
    const [sql, parameters] = qb.getQueryAndParameters();
    sent.push({ sql, parameters });
  };

  /**
   * Stands in for `manager.getRepository(ArtisanVerification)`. Both read APIs
   * are backed by the real query builder so the emitted SQL is genuine; only
   * execution is replaced (with the fixture row) and only the write is a plain
   * spy.
   */
  const verificationRepoDouble = () => {
    const real = dataSource.getRepository(ArtisanVerification);

    return {
      createQueryBuilder: (alias: string) => {
        const qb = real.createQueryBuilder(alias);
        qb.getMany = () => {
          compile(qb);
          return Promise.resolve([verificationRow]);
        };
        return qb;
      },
      find: (options: FindManyOptions<ArtisanVerification>) => {
        const qb = real.createQueryBuilder('verification');
        qb.setFindOptions(options);
        compile(qb);
        return Promise.resolve([verificationRow]);
      },
      update: verificationUpdate,
    };
  };

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      // ts-jest runs the sources directly, so the entities are the .ts files.
      entities: [__dirname + '/../**/*.entity.ts'],
    });
    // `buildMetadatas` is the metadata-only half of TypeORM's own bootstrap
    // (`initialize()` calls it before connecting). It is `protected`, so it is
    // reached through a narrow structural type rather than by widening to
    // `any` — nothing here opens a connection or executes a query.
    await (
      dataSource as unknown as { buildMetadatas(): Promise<void> }
    ).buildMetadatas();
  });

  beforeEach(async () => {
    sent = [];
    jest.clearAllMocks();

    const managerDouble = {
      getRepository: (entity: unknown) =>
        entity === ArtisanVerification
          ? verificationRepoDouble()
          : usersRepoDouble,
      // The other three purge steps write through the manager's query builder;
      // they are covered in `account-purge.service.spec.ts` and only need to
      // not blow up here.
      createQueryBuilder: () => {
        const chain = {
          update: () => chain,
          delete: () => chain,
          from: () => chain,
          set: () => chain,
          where: () => chain,
          execute: () => Promise.resolve({ affected: 1 }),
        };
        return chain;
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccountPurgeService,
        {
          provide: getRepositoryToken(User),
          useValue: {
            find: jest.fn(),
            manager: {
              transaction: (cb: (m: unknown) => unknown): unknown =>
                cb(managerDouble),
            },
          },
        },
        {
          provide: ConfigService,
          useValue: {
            // Armed: the KYC step only runs in destructive mode.
            get: jest
              .fn()
              .mockReturnValue(VARIABLES.ACCOUNT_PURGE_MODE_DESTRUCTIVE),
          },
        },
        { provide: KycMediaService, useValue: kycMedia },
      ],
    }).compile();

    service = module.get(AccountPurgeService);
    usersRepoDouble.findOne.mockResolvedValue(deletedUser);
    kycMedia.deleteByReference.mockResolvedValue(true);
  });

  describe('the emitted query', () => {
    it("is not filtered by the owner's deleted_at — every purge candidate is soft-deleted", async () => {
      await service.purgeAccount(deletedUser.id);

      // The defect, expressed as an assertion: a `deleted_at IS NULL` predicate
      // anywhere in this query makes the whole step unreachable, because the
      // account being purged is always soft-deleted.
      expect(sent).toHaveLength(1);
      expect(sent[0].sql).not.toMatch(/deleted_at/);
    });

    it('joins the artisan profile, and never the soft-deletable users table', async () => {
      await service.purgeAccount(deletedUser.id);

      expect(sent[0].sql).toContain('"artisan_verifications"');
      expect(sent[0].sql).toContain('"artisan_profiles"');
      // `users` is the only table in the join path carrying a
      // `@DeleteDateColumn`, so keeping it out means no soft-delete filter can
      // be appended to this query at all.
      expect(sent[0].sql).not.toContain('"users"');
    });

    it('keys the lookup on the purged user id', async () => {
      await service.purgeAccount(deletedUser.id);

      expect(sent[0].sql).toContain('user_id');
      expect(sent[0].parameters).toContain(deletedUser.id);
    });
  });

  describe('the effect on a soft-deleted artisan with KYC on file', () => {
    it('deletes the stored ID scans and selfie', async () => {
      await service.purgeAccount(deletedUser.id);

      expect(
        (kycMedia.deleteByReference.mock.calls as unknown[][]).map(
          (call) => call[0],
        ),
      ).toEqual([
        verificationRow.documentFrontUrl,
        verificationRow.documentBackUrl,
        verificationRow.selfieUrl,
      ]);
    });

    it('clears the identity columns on the row it found', async () => {
      await service.purgeAccount(deletedUser.id);

      const payload = (verificationUpdate.mock.calls as unknown[][])[0][1] as
        | Record<string, unknown>
        | undefined;
      expect(payload).toBeDefined();
      for (const column of [
        'idNumber',
        'fullLegalName',
        'dateOfBirth',
        'providerRawResponse',
        'documentFrontUrl',
        'documentBackUrl',
        'selfieUrl',
      ]) {
        expect(payload![column]).toBeNull();
      }
    });
  });

  /**
   * Pins the TypeORM behaviour the fix works around, so the reason for the
   * convention stays visible and a future TypeORM upgrade that changes it is
   * noticed here rather than in production.
   */
  it('documents why: relation criteria through `user` DO carry the soft-delete filter', () => {
    const sql = dataSource
      .getRepository(ArtisanVerification)
      .createQueryBuilder('verification')
      .setFindOptions({ where: { artisanProfile: { user: { id: 7 } } } })
      .getSql();

    expect(sql).toContain('LEFT JOIN "users"');
    expect(sql).toMatch(/"deleted_at" IS NULL/);
  });
});
