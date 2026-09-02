import {
  buildPrivateMediaReference,
  buildS3ObjectKey,
  isPrivateUploadFolder,
  isPublicUploadFolder,
  isSafeMediaFilename,
  PRIVATE_S3_KEY_PREFIX,
  PRIVATE_UPLOAD_FOLDERS,
  PUBLIC_UPLOAD_FOLDERS,
} from './upload-folders';

/**
 * The sensitivity split that stops the S3/CDN cutover from publishing KYC
 * identity documents. The properties worth pinning here are the ones a future
 * edit could quietly break:
 *   - every folder is classified, so a new one cannot default to public,
 *   - public keys and URLs are byte-identical to what they were before, and
 *   - no public URL shape can ever be produced for documents/selfies.
 */
describe('upload folder sensitivity split', () => {
  it('classifies every folder as exactly one of public or private', () => {
    const all = [...PUBLIC_UPLOAD_FOLDERS, ...PRIVATE_UPLOAD_FOLDERS];

    expect(new Set(all).size).toBe(all.length);
    for (const folder of all) {
      expect(
        isPublicUploadFolder(folder) !== isPrivateUploadFolder(folder),
      ).toBe(true);
    }
  });

  it('treats the two KYC folders — and only those — as private', () => {
    expect([...PRIVATE_UPLOAD_FOLDERS]).toEqual(['documents', 'selfies']);
    for (const folder of PUBLIC_UPLOAD_FOLDERS) {
      expect(isPrivateUploadFolder(folder)).toBe(false);
    }
  });

  it('does not classify an unknown folder name as either', () => {
    for (const value of ['', 'kyc', 'profiles', 'Documents', '../documents']) {
      expect(isPrivateUploadFolder(value)).toBe(false);
      expect(isPublicUploadFolder(value)).toBe(false);
    }
  });

  describe('buildS3ObjectKey', () => {
    it('leaves every public folder key exactly as it was, so no object moves', () => {
      for (const folder of PUBLIC_UPLOAD_FOLDERS) {
        expect(buildS3ObjectKey(folder, 'abc.jpg')).toBe(`${folder}/abc.jpg`);
        expect(buildS3ObjectKey(folder, 'abc.jpg')).not.toContain(
          PRIVATE_S3_KEY_PREFIX,
        );
      }
    });

    it('puts KYC objects behind the private prefix', () => {
      expect(buildS3ObjectKey('documents', 'abc.pdf')).toBe(
        'private/documents/abc.pdf',
      );
      expect(buildS3ObjectKey('selfies', 'abc.jpg')).toBe(
        'private/selfies/abc.jpg',
      );
    });
  });

  describe('buildPrivateMediaReference', () => {
    it('keeps the historical /uploads/<folder>/<file> shape, so old and new rows read back identically', () => {
      expect(buildPrivateMediaReference('documents', 'abc.pdf')).toBe(
        '/uploads/documents/abc.pdf',
      );
    });

    it('is not a CDN/bucket URL — nothing about it is fetchable', () => {
      const reference = buildPrivateMediaReference('selfies', 'abc.jpg');

      expect(reference.startsWith('/')).toBe(true);
      expect(reference).not.toMatch(/^https?:/);
      expect(reference).not.toContain('amazonaws.com');
    });
  });

  describe('isSafeMediaFilename', () => {
    it('accepts a stored UUID filename', () => {
      expect(
        isSafeMediaFilename('11fc2f6a-517a-4354-bb3e-1a023cdd2940.jpg'),
      ).toBe(true);
    });

    it('rejects anything that could climb out of the folder or hide a path', () => {
      for (const value of [
        '',
        '.',
        '..',
        '../secret.jpg',
        '..%2fsecret.jpg',
        'a/b.jpg',
        'a\\b.jpg',
        '.env',
        '.htaccess',
        'abc.jpg?x=1',
        'abc jpg',
        'abc.jpg\n',
        'abc"; rm -rf /',
      ]) {
        expect(isSafeMediaFilename(value)).toBe(false);
      }
    });
  });
});
