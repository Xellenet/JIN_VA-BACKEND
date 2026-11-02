import { CSV_BOM, csvCell, csvLine, csvNumber } from './csv.util';

describe('csvCell (BU-4.15, SEC-27)', () => {
  it.each([
    ['=SUM(A1)', "'=SUM(A1)"],
    ['+1', "'+1"],
    ['-1', "'-1"],
    ['@x', "'@x"],
    ['\t=x', "'\t=x"],
    ['normal', 'normal'],
    ['', ''],
  ])('neutralises %p', (input, out) => {
    expect(csvCell(input)).toBe(out);
  });

  it('quotes a leading carriage return after neutralising it', () => {
    expect(csvCell('\r=x')).toBe(`"'\r=x"`);
  });

  it('applies RFC 4180 quoting to commas, quotes and newlines', () => {
    expect(csvCell('Fix "kitchen", sink\nnow')).toBe(
      '"Fix ""kitchen"", sink\nnow"',
    );
    expect(csvCell('=a,b')).toBe(`"'=a,b"`);
  });

  it('writes empty cells for null and undefined', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvNumber(null)).toBe('');
    expect(csvNumber(undefined)).toBe('');
  });

  it('never prefixes numbers', () => {
    expect(csvNumber('2400.00')).toBe('2400.00');
    expect(csvNumber(5)).toBe('5');
  });

  it('ends lines with CRLF and exposes the BOM', () => {
    expect(csvLine(['a', 'b'])).toBe('a,b\r\n');
    expect(CSV_BOM).toBe('\uFEFF');
  });
});
