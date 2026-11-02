import {
  ownAvatarPublicBases,
  resolveOwnAvatarFilename,
} from './avatar-path.util';

const BASES = ['https://cdn.example.com/', 'https://media.example.com/jinva'];

describe('resolveOwnAvatarFilename (SEC-5 / T-10)', () => {
  it.each([
    ['/uploads/avatars/3f2a9c.webp', '3f2a9c.webp'],
    ['/uploads/avatars/a_b-c.1.png', 'a_b-c.1.png'],
    ['https://cdn.example.com/avatars/3f2a9c.webp', '3f2a9c.webp'],
    ['https://media.example.com/jinva/avatars/x1.jpg', 'x1.jpg'],
  ])('accepts our own avatar %s', (stored, expected) => {
    expect(resolveOwnAvatarFilename(stored, BASES)).toBe(expected);
  });

  it.each([
    // Not ours.
    'https://lh3.googleusercontent.com/a/ACg8ocK-photo=s96-c',
    'https://tracker.example.com/p.gif',
    'https://cdn.example.com.evil.test/avatars/a.png',
    'https://evil.test/https://cdn.example.com/avatars/a.png',
    'http://cdn.example.com/avatars/a.png',
    // Another folder.
    '/uploads/documents/a.png',
    '/uploads/messages/a.png',
    'https://cdn.example.com/private/selfies/a.png',
    // Traversal and encoding.
    '/uploads/avatars/../documents/a.png',
    '/uploads/avatars/..',
    '/uploads/avatars/%2e%2e%2fdocuments%2fa.png',
    '/uploads/avatars/a%2Fb.png',
    '/uploads/avatars/a%5cb.png',
    '/uploads/avatars/a%252fb.png',
    '/uploads/avatars\\a.png',
    '/uploads/avatars/sub/a.png',
    // Odd shapes.
    '/uploads/avatars/',
    '/uploads/avatars/.hidden',
    '/uploads/avatars/a.png?x=1',
    '/uploads/avatars/a.png#frag',
    '/uploads/avatars/a b.png',
    '/uploads/avatars/a\u0000.png',
    'uploads/avatars/a.png',
    '',
  ])('refuses %p', (stored) => {
    expect(resolveOwnAvatarFilename(stored, BASES)).toBeNull();
  });

  it('refuses non-strings and very long values', () => {
    expect(resolveOwnAvatarFilename(null, BASES)).toBeNull();
    expect(resolveOwnAvatarFilename(undefined, BASES)).toBeNull();
    expect(
      resolveOwnAvatarFilename(`/uploads/avatars/${'a'.repeat(3000)}`, BASES),
    ).toBeNull();
  });

  it('ignores a malformed or non-http configured base', () => {
    expect(
      resolveOwnAvatarFilename('ftp://cdn.example.com/avatars/a.png', [
        'ftp://cdn.example.com',
        'not a url',
        '   ',
      ]),
    ).toBeNull();
  });
});

describe('ownAvatarPublicBases', () => {
  it('builds the bases our S3 provider writes, from configuration names only', () => {
    expect(
      ownAvatarPublicBases({
        AWS_S3_PUBLIC_URL_BASE: 'https://cdn.example.com/',
        AWS_S3_BUCKET: 'jinva-media',
        AWS_S3_REGION: 'eu-west-1',
        AWS_S3_ENDPOINT: 'https://s3.example.net/',
      }),
    ).toEqual([
      'https://cdn.example.com',
      'https://s3.example.net/jinva-media',
      'https://jinva-media.s3.eu-west-1.amazonaws.com',
    ]);
  });

  it('is empty when nothing is configured (local disk only)', () => {
    expect(ownAvatarPublicBases({})).toEqual([]);
  });
});
