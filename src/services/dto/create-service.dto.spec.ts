import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateServiceDto } from './create-service.dto';
import { UpdateServiceDto } from './update-service.dto';

/** QA ADM-11: the admin Services form sends a price, which used to be refused. */
async function errorsFor(
  dto: typeof CreateServiceDto | typeof UpdateServiceDto,
  body: Record<string, unknown>,
): Promise<string[]> {
  const errors = await validate(plainToInstance(dto, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errors.map((e) => e.property);
}

describe('Service price', () => {
  it.each([[150], [0.01], ['99.50']])('accepts %p', async (price) => {
    expect(
      await errorsFor(CreateServiceDto, { name: 'Tiling', price }),
    ).toEqual([]);
  });

  it.each([[0], [-5], [12.345]])('rejects %p', async (price) => {
    expect(
      await errorsFor(CreateServiceDto, { name: 'Tiling', price }),
    ).toEqual(['price']);
  });

  it('stays optional', async () => {
    expect(await errorsFor(CreateServiceDto, { name: 'Tiling' })).toEqual([]);
  });

  it('can be cleared with null on update', async () => {
    const dto = plainToInstance(UpdateServiceDto, { price: null });
    expect(await errorsFor(UpdateServiceDto, { price: null })).toEqual([]);
    expect(dto.price).toBeNull();
  });
});

describe('Service name (QA ADM-10)', () => {
  it('trims and collapses spaces, so " Tile  Laying " matches "Tile Laying"', () => {
    const dto = plainToInstance(CreateServiceDto, { name: '  Tile   Laying ' });
    expect(dto.name).toBe('Tile Laying');
  });

  it('rejects a name that is only spaces', async () => {
    expect(await errorsFor(CreateServiceDto, { name: '   ' })).toEqual([
      'name',
    ]);
  });
});
