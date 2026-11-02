import { nameTokens, payoutNamesMatch } from './payout-name-match';

// Fictional names only.
describe('payout name check: payoutNamesMatch', () => {
  it.each([
    ['Kofi Mensah', 'Kofi Mensah'],
    ['Kofi Mensah', 'KOFI MENSAH'],
    ['  kofi   mensah ', 'Kofi Mensah'],
    ['Kofi Mensah', 'MENSAH KOFI'],
    ['Kofi Mensah', 'Kofi Asante Mensah'],
    ['Kofi Mensah', 'MENSAH, KOFI ASANTE'],
    ['Kofi Asante Mensah', 'Kofi Mensah'],
    ['Akosua Owusu-Ansah', 'AKOSUA OWUSU ANSAH'],
    ['Efua Owusu Ansah', 'Efua Owusu-Ansah'],
    ['Adjoa Frimpong', 'Adjóa Frímpong'],
    ['Adwoa Brémang', 'ADWOA BREMANG'],
    ["Kwame O'Neil", 'KWAME ONEIL'],
    ['Kwame O’Neil', "Kwame O'Neil"],
    ['Mr Yaw Boateng', 'YAW BOATENG'],
    ['Yaw Boateng', 'DR. YAW KWAKU BOATENG'],
    ['Yaw. Boateng!', 'yaw boateng'],
    ['Abena Boateng Boateng', 'Abena Boateng'],
    ['Esi', 'ESI'],
  ])('%p matches %p', (a, b) => {
    expect(payoutNamesMatch(a, b)).toBe(true);
    expect(payoutNamesMatch(b, a)).toBe(true);
  });

  it.each([
    ['Kofi Mensah', 'Ama Serwaa'],
    ['Kofi Mensah', 'Kofi Boateng'],
    ['Kofi Mensah', 'KOFI'],
    ['Kofi', 'Kofi Mensah'],
    ['Kofi Mensah', 'Kofi Mensa'],
    ['Kofi Mensah Junior', 'Kofi Mensah Senior'],
    ['Esi', 'Ama'],
    ['Kofi Mensah', ''],
    ['', ''],
    ['Kofi Mensah', '...'],
    ['Mr', 'Mr'],
  ])('%p does not match %p', (a, b) => {
    expect(payoutNamesMatch(a, b)).toBe(false);
    expect(payoutNamesMatch(b, a)).toBe(false);
  });

  it('never matches a missing name', () => {
    expect(payoutNamesMatch(null, 'Kofi Mensah')).toBe(false);
    expect(payoutNamesMatch('Kofi Mensah', undefined)).toBe(false);
    expect(payoutNamesMatch(null, null)).toBe(false);
  });

  it('needs two shared tokens when one name is longer', () => {
    // Every token of the shorter one is in the longer one, but only one.
    expect(payoutNamesMatch('Mensah', 'Kofi Mensah')).toBe(false);
    expect(payoutNamesMatch('Kofi Mensah', 'Kofi Mensah Asante')).toBe(true);
  });
});

describe('payout name check: nameTokens', () => {
  it('normalises case, accents, punctuation, spaces and titles', () => {
    expect(nameTokens('  Mrs. ÁMA   Sérwaa-BOATENG, Jnr ')).toEqual([
      'ama',
      'serwaa',
      'boateng',
      'jnr',
    ]);
  });

  it('keeps each token once', () => {
    expect(nameTokens('Kofi Kofi Mensah')).toEqual(['kofi', 'mensah']);
  });

  it('returns no tokens for non-strings and blanks', () => {
    expect(nameTokens(undefined)).toEqual([]);
    expect(nameTokens(null)).toEqual([]);
    expect(nameTokens(' - ')).toEqual([]);
  });
});
