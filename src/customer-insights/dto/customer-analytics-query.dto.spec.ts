import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CustomerAnalyticsQueryDto } from './customer-analytics-query.dto';
import {
  AdminAnalyticsQueryDto,
  ArtisanAnalyticsQueryDto,
} from '../../analytics/dto/analytics-query.dto';

const errorsFor = async <T extends object>(cls: new () => T, range: unknown) =>
  validate(plainToInstance(cls, { range }));

describe('CustomerAnalyticsQueryDto (BU-4.6)', () => {
  it.each(['30d', '90d', '12m', 'all'])('accepts %p', async (range) => {
    expect(await errorsFor(CustomerAnalyticsQueryDto, range)).toHaveLength(0);
  });

  it.each(['7d', '1y', '12M', ''])('rejects %p', async (range) => {
    expect(await errorsFor(CustomerAnalyticsQueryDto, range)).toHaveLength(1);
  });

  it('allows no range (defaults to 12m in the controller)', async () => {
    expect(
      await validate(plainToInstance(CustomerAnalyticsQueryDto, {})),
    ).toHaveLength(0);
  });

  it('leaves the artisan and admin ranges unchanged', async () => {
    expect(await errorsFor(ArtisanAnalyticsQueryDto, '7d')).toHaveLength(0);
    expect(await errorsFor(ArtisanAnalyticsQueryDto, '12m')).toHaveLength(1);
    expect(await errorsFor(AdminAnalyticsQueryDto, '1y')).toHaveLength(0);
    expect(await errorsFor(AdminAnalyticsQueryDto, '12m')).toHaveLength(1);
  });
});
