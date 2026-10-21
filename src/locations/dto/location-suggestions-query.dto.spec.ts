import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { LocationSuggestionsQueryDto } from './location-suggestions-query.dto';

async function check(query: Record<string, unknown>) {
  const dto = plainToInstance(LocationSuggestionsQueryDto, query);
  const errors = await validate(dto);
  return { dto, errors };
}

describe('LocationSuggestionsQueryDto (LOC10)', () => {
  it('accepts a trimmed 2–100 character q and a supported country, upper-casing it', async () => {
    const { dto, errors } = await check({ q: '  le  ', country: 'gh' });
    expect(errors).toHaveLength(0);
    expect(dto.q).toBe('le');
    expect(dto.country).toBe('GH');
  });

  it.each([
    ['a 1-character q', { q: 'a', country: 'GH' }],
    ['a q that is 1 character after trimming', { q: '  a  ', country: 'GH' }],
    ['a 101-character q', { q: 'x'.repeat(101), country: 'GH' }],
    ['a missing q', { country: 'GH' }],
    ['an array q', { q: ['le', 'gon'], country: 'GH' }],
    ['an unsupported country', { q: 'legon', country: 'US' }],
    ['a missing country', { q: 'legon' }],
  ])('rejects %s', async (_label, query) => {
    const { errors } = await check(query);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('does not echo the submitted value in its messages (PR5)', async () => {
    const { errors } = await check({ q: 'z', country: 'ZZ' });
    const messages = JSON.stringify(errors.map((e) => e.constraints));
    expect(messages).not.toContain('"z"');
    expect(messages).not.toContain('ZZ');
  });
});
