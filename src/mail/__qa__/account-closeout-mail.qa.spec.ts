/**
 * QA verification of C1.5's deletion email and C1.4's restore email: the
 * rendered body must state the **exact calendar date** of the purge, must link
 * to `/login`, and must carry no restore token.
 *
 * Renders through the real `MailTemplateService` + the real
 * `UserMailListener`, with only the transport stubbed — the delivered inbox
 * is not readable from a test, but the bytes handed to the transport are.
 *
 * Test code only. Run: npm run test -- account-closeout-mail.qa
 */
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { addDays } from 'date-fns';
import { MailService } from '../mail.service';
import { MailTemplateService } from '../mail.template';
import { MailProviderFactory } from '../providers/mail-provider.factory';
import { UserMailListener } from '../listeners/user-mail.listener';

describe('C1.5 / C1.4 account mail (QA)', () => {
  let listener: UserMailListener;
  const sent: { to: string; subject: string; html: string }[] = [];

  const config = {
    get: (key: string) =>
      ({
        MAIL_FROM: 'JinVa <no-reply@jinva.test>',
        FRONTEND_URL: 'https://app.jinva.test',
        APP_NAME: 'JinVa',
        SUPPORT_EMAIL: 'support@jinva.test',
      })[key],
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      providers: [
        UserMailListener,
        MailService,
        MailTemplateService,
        { provide: ConfigService, useValue: config },
        {
          provide: MailProviderFactory,
          useValue: {
            getProvider: () => ({
              send: (m: { to: string; subject: string; html: string }) => {
                sent.push(m);
                return Promise.resolve();
              },
            }),
          },
        },
      ],
    }).compile();
    listener = mod.get(UserMailListener);
  });

  beforeEach(() => (sent.length = 0));

  it('the deletion email states the exact purge date, links to /login, and carries no token', async () => {
    const deletedAt = new Date('2026-09-08T01:15:00.000Z');
    const purgeAt = addDays(deletedAt, 30);

    await listener.handleAccountDeleted({
      email: 'kwame@example.test',
      firstname: 'Kwame',
      deletedAt,
      purgeAt,
    });

    expect(sent).toHaveLength(1);
    const { to, subject, html } = sent[0];

    console.log('C1.5 deletion email =', JSON.stringify({ to, subject }));

    console.log(
      'C1.5 deletion email body (text) =',
      JSON.stringify(
        html
          .replace(/<[^>]*>?/gm, ' ')
          .replace(/\s+/g, ' ')
          .trim(),
      ),
    );

    expect(to).toBe('kwame@example.test');
    // The exact calendar date, not a relative duration.
    expect(html).toContain('8 October 2026');
    expect(html).toContain('8 September 2026');
    expect(html).toContain('https://app.jinva.test/login');
    // No tokenised one-click restore URL of any kind.
    expect(html).not.toMatch(/token=/i);
    expect(html).not.toMatch(/restore-account/i);
    // The security notice C1.5 requires, for someone who did not delete it.
    expect(html).toMatch(
      /Didn&#x27;t delete your account\?|Didn't delete your account\?/,
    );
  });

  it('the restore email confirms the restore and links to /login', async () => {
    await listener.handleAccountRestored({
      email: 'kwame@example.test',
      firstname: 'Kwame',
    });
    expect(sent).toHaveLength(1);

    console.log(
      'C1.4 restore email =',
      JSON.stringify({ subject: sent[0].subject }),
    );

    console.log(
      'C1.4 restore email body (text) =',
      JSON.stringify(
        sent[0].html
          .replace(/<[^>]*>?/gm, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 700),
      ),
    );
    expect(sent[0].html).toContain('https://app.jinva.test/login');
    expect(sent[0].html).not.toMatch(/token=/i);
  });

  it('a transport failure never propagates out of either listener (C1.5)', async () => {
    const mod = await Test.createTestingModule({
      providers: [
        UserMailListener,
        MailService,
        MailTemplateService,
        { provide: ConfigService, useValue: config },
        {
          provide: MailProviderFactory,
          useValue: {
            getProvider: () => ({
              send: () => Promise.reject(new Error('smtp down')),
            }),
          },
        },
      ],
    }).compile();
    const failing = mod.get(UserMailListener);

    await expect(
      failing.handleAccountDeleted({
        email: 'a@b.test',
        firstname: 'A',
        deletedAt: new Date(),
        purgeAt: new Date(),
      }),
    ).resolves.toBeUndefined();
    await expect(
      failing.handleAccountRestored({ email: 'a@b.test', firstname: 'A' }),
    ).resolves.toBeUndefined();
  });
});
