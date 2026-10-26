import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateApplicationDto } from './create-application.dto';

/** QA JOB-08: a quote becomes the payment amount, so it must be a real price. */
async function errorsFor(body: Record<string, unknown>): Promise<string[]> {
  const errors = await validate(plainToInstance(CreateApplicationDto, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errors.map((e) => e.property);
}

describe('CreateApplicationDto quotePrice', () => {
  it.each([[150], [0.01], [99.5], ['120.25']])(
    'accepts %p',
    async (quotePrice) => {
      expect(await errorsFor({ quotePrice })).toEqual([]);
    },
  );

  it.each([[0], [-10], [12.345]])('rejects %p', async (quotePrice) => {
    expect(await errorsFor({ quotePrice })).toEqual(['quotePrice']);
  });

  it('stays optional, so an application may fall back to the budget', async () => {
    expect(await errorsFor({ message: 'Available this week' })).toEqual([]);
  });
});
