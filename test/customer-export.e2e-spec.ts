/**
 * Customer experience v2, B10 `GET /payments/history/export.csv` (test plan
 * E-4.20 to E-4.24, SEC-27/T-7, T-1, T-2, T-6). Fictional data only.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { DataSource, Repository } from 'typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import cookieParser from 'cookie-parser';
import type { Logger as WinstonLogger } from 'winston';
import { AppModule } from '../src/app.module';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { TypeOrmFilter } from '../src/common/filters/typeorm-exception.filter';
import { User } from '@users/entities/user.entity';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { UserTokenService } from '@users/token.service';
import { ServiceEntity } from '@services/entities/service.entity';
import { Role } from '@common/types/enums';
import { FORBIDDEN_KEYS } from './support/forbidden-fields';

jest.setTimeout(180000);

const PREV_LIMIT = process.env.CUSTOMER_EXPORT_RATE_LIMIT_PER_10_MINUTES;
process.env.CUSTOMER_EXPORT_RATE_LIMIT_PER_10_MINUTES = '40';

const DAY = 86_400_000;

/** Minimal RFC 4180 parser for the assertions. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else cell += ch;
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows;
}

describe('Customer CSV export (B10)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  const uniq = Date.now();
  const token: Record<string, string> = {};
  const userId: Record<string, number> = {};
  const profileId: Record<string, number> = {};
  const serviceIds: number[] = [];
  const server = () => app.getHttpServer();
  const as = (who: string) => ({ Authorization: `Bearer ${token[who]}` });
  const csv = (query = '', who = 'a') =>
    request(server())
      .get(`/api/v1/payments/history/export.csv${query ? `?${query}` : ''}`)
      .set(as(who))
      .set('User-Agent', 'JinVa e2e agent')
      .buffer(true)
      .parse((res, cb) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (data += chunk));
        res.on('end', () => cb(null, data));
      });
  let refSeq = 0;
  const K_PHONE = '+233240000373';
  const K_EMAIL = `cxe-k-${uniq}@test.jinva.local`;

  const pay = async (
    who: string,
    title: string,
    svc: number,
    amount: number,
    status: string,
    daysAgo: number,
    extra: {
      refunded?: number;
      channel?: string | null;
      reference?: string;
    } = {},
  ) => {
    const [job] = await dataSource.query<Array<{ id: number }>>(
      `INSERT INTO jobs (customer_id, service_id, title, location, status) VALUES ($1,$2,$3,'Osu, Accra','COMPLETED') RETURNING id`,
      [userId[who], serviceIds[svc], title],
    );
    const paidAt =
      status === 'PENDING' ? null : new Date(Date.now() - daysAgo * DAY);
    await dataSource.query(
      `INSERT INTO payments (job_id, customer_id, artisan_profile_id, amount, platform_fee, artisan_amount, status, reference,
         channel, refunded_amount, paid_at, released_at, created_at, transfer_code, access_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'TRF_fake','ACC_fake')`,
      [
        job.id,
        userId[who],
        profileId.K,
        amount,
        amount * 0.1,
        amount * 0.9,
        status,
        extra.reference ?? `CXE-${uniq}-${who}-${++refSeq}`,
        extra.channel === undefined ? 'card' : extra.channel,
        extra.refunded ?? 0,
        paidAt,
        status === 'RELEASED' && paidAt
          ? new Date(paidAt.getTime() + DAY)
          : null,
        new Date(Date.now() - daysAgo * DAY - 60_000),
      ],
    );
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
    const logger = app.get<WinstonLogger>(WINSTON_MODULE_NEST_PROVIDER);
    app.useGlobalFilters(new AllExceptionsFilter(logger), new TypeOrmFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.setGlobalPrefix('api/v1', { exclude: ['/'] });
    await app.init();
    dataSource = moduleFixture.get(DataSource);

    const services: Repository<ServiceEntity> = moduleFixture.get(
      getRepositoryToken(ServiceEntity),
    );
    for (const name of ['Plumbing', 'Electrical']) {
      serviceIds.push(
        (
          await services.save(
            services.create({
              name: `${name} ${uniq}`,
              estimatedDurationMins: 60,
            }),
          )
        ).id,
      );
    }
    const users: Repository<User> = moduleFixture.get(getRepositoryToken(User));
    const profiles: Repository<ArtisanProfile> = moduleFixture.get(
      getRepositoryToken(ArtisanProfile),
    );
    const tokens = moduleFixture.get(UserTokenService);
    const make = async (
      label: string,
      role: Role,
      first: string,
      last: string,
      extra: Partial<User> = {},
    ) => {
      const u = await users.save(
        users.create({
          email: `cxe-${label.toLowerCase()}-${uniq}@test.jinva.local`,
          username: `cxe${label}${uniq}`,
          firstname: first,
          lastname: last,
          role,
          accountVerified: true,
          ...extra,
        }),
      );
      userId[label] = u.id;
      token[label] = (await tokens.createJWTTokens(u)).access_token;
      if (role === Role.ARTISAN) {
        profileId[label] = (
          await profiles.save(
            profiles.create({
              user: u,
              hourlyRate: 80,
              location: 'Tema',
              currency: 'GHS',
              isProfileComplete: true,
              payoutAccountNumber: '0240000777',
            }),
          )
        ).id;
      }
    };
    await make('a', Role.CUSTOMER, 'Ama', 'Owusu');
    await make('b', Role.CUSTOMER, 'Kwame', 'Boateng');
    await make('big', Role.CUSTOMER, 'Kojo', 'Addo');
    await make('old', Role.CUSTOMER, 'Afia', 'Danso');
    await make('t', Role.CUSTOMER, 'Esi', 'Nyarko');
    await make('K', Role.ARTISAN, 'Kofi', 'Asante', { phoneNumber: K_PHONE });
    await make('admin', Role.ADMIN, 'Efua', 'Badu');
    await dataSource.query(`UPDATE users SET email = $1 WHERE id = $2`, [
      K_EMAIL,
      userId.K,
    ]);

    await pay('a', '=SUM(1+1)', 0, 2400, 'RELEASED', 10, {
      reference: `JINVA-EXP-${uniq}`,
      channel: 'mobile_money',
    });
    await pay('a', '@cmd', 1, 800, 'RELEASED', 20, { refunded: 200 });
    await pay('a', 'Fix "kitchen", sink', 0, 500, 'HELD', 5, {
      channel: 'bank_transfer',
    });
    await pay('a', '-1 discount', 1, 300, 'PENDING', 1, { channel: null });
    await pay('a', '+tap', 0, 120, 'FAILED', 3, { channel: null });
    await pay('b', 'B private job', 0, 4321, 'RELEASED', 4);
    // `old` paid 30 months ago and today: an unbounded export spans > 24 months.
    await pay('old', 'Old job', 0, 100, 'RELEASED', 30 * 30);
    await pay('old', 'New job', 0, 100, 'RELEASED', 1);
    // `big` has 10,001 payments in range (one job, inserted in one statement).
    const [bigJob] = await dataSource.query<Array<{ id: number }>>(
      `INSERT INTO jobs (customer_id, service_id, title, location, status) VALUES ($1,$2,'Bulk job','Osu','COMPLETED') RETURNING id`,
      [userId.big, serviceIds[0]],
    );
    await dataSource.query(
      `INSERT INTO payments (job_id, customer_id, artisan_profile_id, amount, platform_fee, artisan_amount, status, reference, paid_at)
       SELECT $1, $2, $3, 10, 1, 9, 'RELEASED', 'CXE-BIG-' || $4 || '-' || g, NOW() - (g || ' minutes')::interval
       FROM generate_series(1, 10001) g`,
      [bigJob.id, userId.big, profileId.K, String(uniq)],
    );
  });

  afterAll(async () => {
    if (PREV_LIMIT === undefined)
      delete process.env.CUSTOMER_EXPORT_RATE_LIMIT_PER_10_MINUTES;
    else process.env.CUSTOMER_EXPORT_RATE_LIMIT_PER_10_MINUTES = PREV_LIMIT;
    await app.close();
  });

  it('E-4.20 streams a formula-safe CSV with the agreed headers', async () => {
    const res = await csv();
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-store');
    const today = new Date().toISOString().slice(0, 10);
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="jinva-payments-${today}.csv"`,
    );
    const text = res.body as string;
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const rows = parseCsv(text.slice(1));
    expect(rows[0]).toEqual([
      'Date paid',
      'Reference',
      'Job',
      'Service',
      'Artisan',
      'Method',
      'Status',
      'Amount (GHS)',
      'Refunded (GHS)',
      'Net (GHS)',
      'Paid to artisan',
    ]);
    expect(rows).toHaveLength(6);
    const byJob = new Map(rows.slice(1).map((r) => [r[2], r]));
    expect(byJob.get("'=SUM(1+1)")).toBeDefined();
    expect(byJob.get("'@cmd")).toBeDefined();
    expect(byJob.get("'-1 discount")).toBeDefined();
    expect(byJob.get("'+tap")).toBeDefined();
    expect(byJob.get('Fix "kitchen", sink')).toBeDefined();
    // The raw file quotes the comma/quote cell.
    expect(text).toContain('"Fix ""kitchen"", sink"');
    const sumRow = byJob.get("'=SUM(1+1)")!;
    expect(sumRow[1]).toBe(`JINVA-EXP-${uniq}`);
    expect(sumRow[3]).toBe(`Plumbing ${uniq}`);
    expect(sumRow[4]).toBe('Kofi Asante');
    expect(sumRow[5]).toBe('Mobile money');
    expect(sumRow[6]).toBe('Paid Out');
    expect(sumRow.slice(7, 10)).toEqual(['2400.00', '0.00', '2400.00']);
    expect(sumRow[0]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(sumRow[10]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(byJob.get("'@cmd")!.slice(7, 10)).toEqual([
      '800.00',
      '200.00',
      '600.00',
    ]);
    expect(byJob.get('Fix "kitchen", sink')![5]).toBe('Bank');
    expect(byJob.get('Fix "kitchen", sink')![6]).toBe('Withheld');
    expect(byJob.get("'-1 discount")![5]).toBe('Not paid yet');
    expect(byJob.get("'-1 discount")![6]).toBe('Awaiting payment');
    expect(byJob.get("'-1 discount")![0]).toBe('');
    expect(text.toLowerCase()).not.toContain('escrow');
  });

  it('E-4.21 applies the B3 filters and their validation', async () => {
    const rows = parseCsv(
      ((await csv(`serviceId=${serviceIds[1]}`)).body as string).slice(1),
    );
    expect(rows.slice(1).map((r) => r[3])).toEqual([
      `Electrical ${uniq}`,
      `Electrical ${uniq}`,
    ]);
    const held = parseCsv(
      ((await csv('status=HELD&search=kitchen')).body as string).slice(1),
    );
    expect(held).toHaveLength(2);
    for (const q of [
      'page=1',
      'limit=10',
      'status=FOO',
      'range=12m&from=2026-01-01',
      'from=2026-10-30&to=2026-01-01',
      `customerId=${userId.b}`,
    ]) {
      expect({ q, s: (await csv(q)).status }).toEqual({ q, s: 400 });
    }
  });

  it('E-4.22 / T-2 has no forbidden columns, no artisan contact, no email in the file name', async () => {
    const res = await csv();
    const text = res.body as string;
    const header = parseCsv(text.slice(1))[0].map((h) => h.toLowerCase());
    for (const key of FORBIDDEN_KEYS)
      expect(header).not.toContain(key.toLowerCase());
    for (const leak of [
      K_PHONE,
      K_EMAIL,
      '0240000777',
      'TRF_fake',
      'ACC_fake',
      '240.00' /* platform fee */,
    ]) {
      expect(text).not.toContain(leak);
    }
    expect(res.headers['content-disposition']).not.toMatch(/@|owusu|ama/i);
  });

  it('E-4.23 records one security event with filter flags and the row count only', async () => {
    await dataSource.query(
      `DELETE FROM account_security_events WHERE user_id = $1`,
      [userId.a],
    );
    await csv('status=RELEASED,HELD&search=kitchen&range=12m');
    const events = await dataSource.query<
      Array<{
        event: string;
        details: Record<string, unknown>;
        ip: string | null;
        user_agent: string;
      }>
    >(
      `SELECT event, fields_changed, details, ip, user_agent FROM account_security_events WHERE user_id = $1`,
      [userId.a],
    );
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('spending_report.exported');
    expect(events[0].user_agent).toBe('JinVa e2e agent');
    expect(events[0].details).toEqual({
      range: '12m',
      statuses: ['RELEASED', 'HELD'],
      hasServiceFilter: false,
      hasArtisanFilter: false,
      hasSearch: true,
      hasDateRange: false,
      rowCount: 1,
    });
    expect(JSON.stringify(events[0])).not.toContain('kitchen');
  });

  it("E-4.24 / E-4.6 is customer-only and B gets only B's rows", async () => {
    expect((await csv('', 'K')).status).toBe(403);
    expect((await csv('', 'admin')).status).toBe(403);
    expect(
      (await request(server()).get('/api/v1/payments/history/export.csv'))
        .status,
    ).toBe(401);
    const text = (await csv(`serviceId=${serviceIds[0]}`, 'b')).body as string;
    const rows = parseCsv(text.slice(1));
    expect(rows).toHaveLength(2);
    expect(rows[1][2]).toBe('B private job');
    expect(text).not.toContain(`JINVA-EXP-${uniq}`);
  });

  it('refuses an export over 24 months with EXPORT_RANGE_TOO_LARGE', async () => {
    const res = await csv('', 'old');
    expect(res.status).toBe(400);
    const body = JSON.parse(res.body as string) as {
      message: string;
      meta: { error: string };
    };
    expect(body.meta.error).toBe('EXPORT_RANGE_TOO_LARGE');
    expect(body.message).toBe(
      'Narrow the date range to 24 months or less, then download again.',
    );
    // Narrowed to 12 months it works.
    expect((await csv('range=12m', 'old')).status).toBe(200);
  });

  it('refuses more than 10,000 rows with EXPORT_TOO_MANY_ROWS', async () => {
    const res = await csv('', 'big');
    expect(res.status).toBe(400);
    const body = JSON.parse(res.body as string) as { meta: { error: string } };
    expect(body.meta.error).toBe('EXPORT_TOO_MANY_ROWS');
  });

  it('streams in keyset batches without losing or repeating rows', async () => {
    // 10,001 rows minus the newest one fits; it crosses many 500-row batches.
    const from = new Date(Date.now() - 20 * DAY).toISOString().slice(0, 10);
    await dataSource.query(
      `DELETE FROM payments WHERE id = (SELECT id FROM payments WHERE customer_id = $1 ORDER BY paid_at DESC LIMIT 1)`,
      [userId.big],
    );
    const res = await csv(`from=${from}`, 'big');
    expect(res.status).toBe(200);
    const rows = parseCsv((res.body as string).slice(1)).slice(1);
    expect(rows).toHaveLength(10_000);
    expect(new Set(rows.map((r) => r[1])).size).toBe(10_000);
  });

  it('T-6 is throttled per user on the customer-export limit', async () => {
    let last = await csv('', 't');
    for (let i = 0; i < 41 && last.status === 200; i++)
      last = await csv('', 't');
    expect(last.status).toBe(429);
    const body = JSON.parse(last.body as string) as {
      message: string;
      meta: { error: string };
    };
    expect(body.meta.error).toBe('CUSTOMER_EXPORT_RATE_LIMIT_EXCEEDED');
    expect(body.message).toBe('Too many requests, please wait a moment.');
    expect((await csv('', 'b')).status).toBe(200);
  });
});
