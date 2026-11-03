import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DocumentType } from '@common/types/enums';
import { SubmitVerificationDto } from './submit-verification.dto';

/**
 * The back of the document is required for every type that has one, and
 * optional only for a passport (its photo page has no back).
 */
describe('SubmitVerificationDto — back of the document', () => {
  const base = {
    idNumber: 'GHA-123456789-0',
    fullLegalName: 'Kofi Asante',
    documentFrontUrl:
      '/uploads/documents/9f1c2b8e-2222-4000-8000-bbbbbbbbbbbb.jpg',
    selfieUrl: '/uploads/selfies/9f1c2b8e-3333-4000-8000-cccccccccccc.jpg',
  };
  const back = '/uploads/documents/9f1c2b8e-4444-4000-8000-dddddddddddd.jpg';
  const backErrors = async (body: Record<string, unknown>) =>
    (await validate(plainToInstance(SubmitVerificationDto, body)))
      .filter((e) => e.property === 'documentBackUrl')
      .flatMap((e) => Object.values(e.constraints ?? {}));

  it.each([
    DocumentType.GHANA_CARD,
    DocumentType.VOTERS_ID,
    DocumentType.DRIVERS_LICENSE,
    DocumentType.NATIONAL_ID,
  ])('requires the back for %s', async (documentType) => {
    expect(await backErrors({ ...base, documentType })).toContain(
      'Add the back of your document too.',
    );
    expect(
      await backErrors({ ...base, documentType, documentBackUrl: '' }),
    ).not.toHaveLength(0);
    expect(
      await backErrors({ ...base, documentType, documentBackUrl: back }),
    ).toEqual([]);
  });

  it('does not require a back for a passport, but still checks one that is sent', async () => {
    expect(
      await backErrors({ ...base, documentType: DocumentType.PASSPORT }),
    ).toEqual([]);
    expect(
      await backErrors({
        ...base,
        documentType: DocumentType.PASSPORT,
        documentBackUrl: back,
      }),
    ).toEqual([]);
    expect(
      await backErrors({
        ...base,
        documentType: DocumentType.PASSPORT,
        documentBackUrl: 'https://evil.example.com/x.jpg',
      }),
    ).not.toHaveLength(0);
  });
});
