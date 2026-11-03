import { VARIABLES } from '@common/constants/variables.constants';
import {
  firstFreeUsername,
  foldNamePart,
  isValidUsername,
  usernameBase,
  usernameCandidate,
} from './username-generator.util';

describe('username generator (auth v2)', () => {
  it('builds first.last, lower-case', () => {
    expect(usernameBase('Kofi', 'Asante')).toBe('kofi.asante');
  });

  it.each([
    ['Ẹ̀sí', 'Ọ̀kọ́', 'esi.oko'],
    ['Adwoa', 'Bonsu-Mensah', 'adwoa.bonsumensah'],
    ['Mary Jane', "O'Neil", 'maryjane.oneil'],
    ['Søren', 'Ærøskøbing', 'soren.aeroskobing'],
    ['Łukasz', 'Straße', 'lukasz.strasse'],
    ['José', 'Núñez', 'jose.nunez'],
  ])(
    'folds accents and drops other characters: %s %s → %s',
    (first, last, expected) => {
      expect(usernameBase(first, last)).toBe(expected);
    },
  );

  it('never uses anything but the names', () => {
    expect(usernameBase('Ama', 'Mensah')).not.toMatch(/@|\+|\d/);
  });

  it('copes with names that leave nothing, or too little', () => {
    expect(usernameBase('李', '王')).toBe('user');
    expect(usernameBase('', '')).toBe('user');
    expect(usernameBase('Al', '')).toBe('al.user');
    expect(usernameBase('', 'Bo')).toBe('bo.user');
    expect(usernameBase('Jo', 'Li')).toBe('jo.li');
  });

  it('keeps room for a suffix within 30 characters and never ends on a dot', () => {
    const base = usernameBase(
      'Bartholomew',
      'Montgomeryshire-Featherstonehaugh',
    );
    expect(base.length).toBeLessThanOrEqual(26);
    expect(base.endsWith('.')).toBe(false);
    expect(usernameCandidate(base, 9999).length).toBeLessThanOrEqual(30);
    const cutAtDot = usernameBase('abcdefghijklmnopqrstuvwxy', 'z');
    expect(cutAtDot).toBe('abcdefghijklmnopqrstuvwxy');
  });

  it('numbers collisions base, base2, base3…', () => {
    expect(usernameCandidate('kofi.asante', 1)).toBe('kofi.asante');
    expect(usernameCandidate('kofi.asante', 2)).toBe('kofi.asante2');
    expect(firstFreeUsername('kofi.asante', [])).toBe('kofi.asante');
    expect(firstFreeUsername('kofi.asante', ['Kofi.Asante'])).toBe(
      'kofi.asante2',
    );
    expect(
      firstFreeUsername('kofi.asante', [
        'kofi.asante',
        'kofi.asante2',
        'kofi.asante3',
      ]),
    ).toBe('kofi.asante4');
    expect(
      firstFreeUsername('kofi.asante', ['kofi.asante', 'kofi.asante3']),
    ).toBe('kofi.asante2');
  });

  it('ignores names that only share the prefix', () => {
    expect(
      firstFreeUsername('kofi.asante', [
        'kofi.asantewaa',
        'kofi.asante1',
        'kofi.asante02',
        'kofixasante',
      ]),
    ).toBe('kofi.asante');
    // A dot in the base is literal, not "any character".
    expect(firstFreeUsername('a.b', ['axb'])).toBe('a.b');
  });

  it('only ever produces values the username rule accepts', () => {
    const names: Array<[string, string]> = [
      ['Kofi', 'Asante'],
      ['Ẹ̀sí', 'Ọ̀kọ́'],
      ['', ''],
      ['.', '..'],
      ['_x_', '_y_'],
      ['A', 'B'],
      ['Bartholomew', 'Montgomeryshire-Featherstonehaugh'],
    ];
    for (const [first, last] of names) {
      const base = usernameBase(first, last);
      for (const n of [1, 2, 37, 9999]) {
        const candidate = usernameCandidate(base, n);
        expect(isValidUsername(candidate)).toBe(true);
        expect(VARIABLES.USERNAME_REGEX.test(candidate)).toBe(true);
      }
    }
    expect(isValidUsername('a..b')).toBe(false);
  });

  it('foldNamePart handles empty input', () => {
    expect(foldNamePart(undefined)).toBe('');
    expect(foldNamePart(null)).toBe('');
  });
});
