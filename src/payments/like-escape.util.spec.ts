import { containsPattern, escapeLike } from './like-escape.util';

describe('escapeLike', () => {
  it('escapes %, _ and backslash', () => {
    expect(escapeLike('50%')).toBe('50\\%');
    expect(escapeLike('a_b')).toBe('a\\_b');
    expect(escapeLike('c:\\path')).toBe('c:\\\\path');
    expect(escapeLike("' OR 1=1 --")).toBe("' OR 1=1 --");
  });

  it('wraps a contains pattern', () => {
    expect(containsPattern('rewire')).toBe('%rewire%');
    expect(containsPattern('%')).toBe('%\\%%');
  });
});
