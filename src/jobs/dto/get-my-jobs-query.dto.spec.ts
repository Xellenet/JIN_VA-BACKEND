import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { GetMyJobsQueryDto, splitCommaList } from './get-my-jobs-query.dto';
import { GetJobsQueryDto } from './get-jobs-query.dto';

const parse = async (query: Record<string, unknown>) => {
  const dto = plainToInstance(GetMyJobsQueryDto, query);
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { dto, errors };
};

describe('GetMyJobsQueryDto (B7b)', () => {
  it('BU-1.4 parses a comma list of statuses', async () => {
    const { dto, errors } = await parse({ status: 'PENDING,IN_PROGRESS' });
    expect(errors).toHaveLength(0);
    expect(dto.status).toEqual(['PENDING', 'IN_PROGRESS']);
  });

  it.each(['OPEN,FOO', ',', 'open', 'OPEN;DROP', ''])(
    'BU-1.5 rejects status=%p, naming the status field',
    async (status) => {
      const { errors } = await parse({ status });
      expect(errors.map((e) => e.property)).toContain('status');
    },
  );

  it('BU-1.6 one status parses to a one-item list; none stays undefined', async () => {
    expect((await parse({ status: 'OPEN' })).dto.status).toEqual(['OPEN']);
    const none = await parse({});
    expect(none.errors).toHaveLength(0);
    expect(none.dto.status).toBeUndefined();
  });

  it('BU-1.7 de-duplicates and trims, and accepts repeated parameters', async () => {
    expect((await parse({ status: 'OPEN, OPEN ' })).dto.status).toEqual([
      'OPEN',
    ]);
    expect(
      (await parse({ status: ['OPEN', 'PENDING,OPEN'] })).dto.status,
    ).toEqual(['OPEN', 'PENDING']);
  });

  it('caps the list at the six statuses and limit at 50', async () => {
    // Repeats are de-duplicated before the size check.
    const repeats = (await parse({ status: Array(7).fill('OPEN').join(',') }))
      .dto;
    expect(repeats.status).toEqual(['OPEN']);
    expect((await parse({ limit: '51' })).errors).toHaveLength(1);
    expect((await parse({ page: '0' })).errors).toHaveLength(1);
    const ok = await parse({
      limit: '50',
      page: '2',
      serviceId: '3',
      location: 'Osu',
    });
    expect(ok.errors).toHaveLength(0);
    expect(ok.dto).toMatchObject({ limit: 50, page: 2, serviceId: 3 });
  });

  it('rejects owner parameters', async () => {
    const { errors } = await parse({ customerId: '9' });
    expect(errors.map((e) => e.property)).toContain('customerId');
  });

  it('leaves GetJobsQueryDto single-status', async () => {
    const dto = plainToInstance(GetJobsQueryDto, { status: 'OPEN,PENDING' });
    expect((await validate(dto)).map((e) => e.property)).toContain('status');
  });

  it('splitCommaList passes null and undefined through', () => {
    expect(splitCommaList(undefined)).toBeUndefined();
    expect(splitCommaList(null)).toBeNull();
    expect(splitCommaList(5)).toEqual([5]);
  });
});
