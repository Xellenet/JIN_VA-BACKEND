import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateJobDto } from '@jobs/dto/create-job.dto';
import { UpdateJobDto } from '@jobs/dto/update-job.dto';
import { CreateBookingDto } from '../../bookings/dto/create-booking.dto';
import {
  decimalToNumber,
  exactLocationColumns,
  GHANA_BOUNDS,
  isInGhana,
  redactExactLocation,
} from './exact-location';

// Fictional test points only: Adum (Kumasi), Lomé (Togo), London.
const ADUM = { latitude: 6.6885, longitude: -1.6244 };

describe('isInGhana', () => {
  it('accepts points in Ghana, including the box edges', () => {
    expect(isInGhana(ADUM.latitude, ADUM.longitude)).toBe(true);
    expect(isInGhana(GHANA_BOUNDS.minLat, GHANA_BOUNDS.minLon)).toBe(true);
    expect(isInGhana(GHANA_BOUNDS.maxLat, GHANA_BOUNDS.maxLon)).toBe(true);
  });

  it.each([
    ['Lomé', 6.13, 1.25],
    ['London', 51.5, -0.12],
    ['the Gulf of Guinea', 4.4, -1],
    ['NaN', Number.NaN, -1],
    ['Infinity', 6, Number.POSITIVE_INFINITY],
  ])('rejects %s', (_label, lat, lon) => {
    expect(isInGhana(lat, lon)).toBe(false);
  });
});

describe('exactLocationColumns', () => {
  it('keeps a full point, rounds the accuracy and trims the landmark', () => {
    expect(
      exactLocationColumns({
        ...ADUM,
        locationAccuracyM: 8.4,
        landmark: '  Opposite Adum Post Office, blue gate ',
      }),
    ).toEqual({
      ...ADUM,
      locationAccuracyM: 8,
      landmark: 'Opposite Adum Post Office, blue gate',
    });
  });

  it('sends nothing for fields the client left out (old clients, partial updates)', () => {
    expect(exactLocationColumns({})).toEqual({});
  });

  it('clears the point and its accuracy together', () => {
    expect(
      exactLocationColumns({
        latitude: null,
        longitude: null,
        locationAccuracyM: 12,
      }),
    ).toEqual({ latitude: null, longitude: null, locationAccuracyM: null });
  });

  it('stores a blank landmark as null', () => {
    expect(exactLocationColumns({ landmark: '   ' })).toEqual({
      landmark: null,
    });
  });
});

describe('redactExactLocation', () => {
  it('removes the four private fields and keeps the area', () => {
    const dto = {
      id: 1,
      location: 'Adum, Kumasi',
      ...ADUM,
      locationAccuracyM: 8,
      landmark: 'Blue gate',
    };
    expect(redactExactLocation(dto)).toEqual({
      id: 1,
      location: 'Adum, Kumasi',
    });
  });
});

describe('decimalToNumber', () => {
  it('turns pg numeric strings into numbers and keeps null', () => {
    expect(decimalToNumber.from('6.688500')).toBe(6.6885);
    expect(decimalToNumber.from(null)).toBeNull();
    expect(decimalToNumber.from(undefined)).toBeNull();
    expect(decimalToNumber.to(6.6885)).toBe(6.6885);
  });
});

describe('pin validation on the write DTOs', () => {
  const job = {
    title: 'Fix a leaking tap',
    serviceId: 1,
    location: 'Adum, Kumasi',
    currency: 'GHS',
  };
  const errorsOf = async (cls: new () => object, body: object) =>
    (await validate(plainToInstance(cls, body))).map((e) => e.property);

  it('accepts a job with no pin (old clients) and with a pin in Ghana', async () => {
    expect(await errorsOf(CreateJobDto, job)).toEqual([]);
    expect(
      await errorsOf(CreateJobDto, {
        ...job,
        ...ADUM,
        locationAccuracyM: 8,
        landmark: 'Blue gate',
      }),
    ).toEqual([]);
  });

  it.each([
    [
      'outside Ghana (Lomé)',
      { latitude: 6.13, longitude: 1.25 },
      ['longitude'],
    ],
    [
      'outside Ghana (London)',
      { latitude: 51.5, longitude: -0.12 },
      ['latitude'],
    ],
    ['only a latitude', { latitude: 6.6885 }, ['longitude']],
    ['only a longitude', { longitude: -1.6244 }, ['latitude']],
    ['a text latitude', { latitude: 'here', longitude: -1.6 }, ['latitude']],
    [
      'a negative accuracy',
      { ...ADUM, locationAccuracyM: -1 },
      ['locationAccuracyM'],
    ],
    ['a long landmark', { ...ADUM, landmark: 'x'.repeat(141) }, ['landmark']],
  ])('rejects %s', async (_label, extra, props) => {
    expect(await errorsOf(CreateJobDto, { ...job, ...extra })).toEqual(props);
  });

  it('says the pin must be in Ghana', async () => {
    const [error] = await validate(
      plainToInstance(CreateJobDto, {
        ...job,
        latitude: 6.13,
        longitude: 1.25,
      }),
    );
    expect(Object.values(error.constraints ?? {})).toContain(
      'The pinned location must be in Ghana.',
    );
  });

  it('lets an update clear the pin with nulls', async () => {
    expect(
      await errorsOf(UpdateJobDto, { latitude: null, longitude: null }),
    ).toEqual([]);
    expect(
      await errorsOf(UpdateJobDto, { latitude: null, longitude: -1.6 }),
    ).toEqual(['latitude']);
  });

  it('validates a booking pin the same way, location optional', async () => {
    const booking = {
      artisanProfileId: 1,
      serviceId: 1,
      scheduledDate: '2026-12-01',
      startTime: '09:00',
    };
    expect(await errorsOf(CreateBookingDto, booking)).toEqual([]);
    expect(
      await errorsOf(CreateBookingDto, {
        ...booking,
        location: 'Adum, Kumasi',
        ...ADUM,
      }),
    ).toEqual([]);
    expect(
      await errorsOf(CreateBookingDto, {
        ...booking,
        latitude: 6.13,
        longitude: 1.25,
      }),
    ).toEqual(['longitude']);
    expect(
      await errorsOf(CreateBookingDto, {
        ...booking,
        location: 'x'.repeat(201),
      }),
    ).toEqual(['location']);
  });
});
