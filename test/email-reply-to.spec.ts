// MONEY-MAIL-128 (FW-MONEY-128 B-2) — payment and dunning emails come from a
// no-mailbox sender. A client's reply must reach that client's coach; with no
// coach (or a coach/platform email) it reaches support. The template line says
// exactly where the reply goes. Other templates keep their behaviour.
import { ConfigService } from '@nestjs/config';
import { EmailService } from '../src/email/email.service';
import { PrismaService } from '../src/prisma.service';
import { EmailTemplateKey } from '../src/email/email.types';
import { SUPPORT_EMAIL } from '../src/public-pages/trust-pages.html';

const COACH_ID = 'coach-1';
const COACH_EMAIL = 'coach@example.com';

function mockPrisma(coachEmail: string | null = COACH_EMAIL) {
  return {
    emailSendLog: {
      create: jest.fn().mockResolvedValue({ id: 'row-1' }),
      update: jest.fn().mockResolvedValue({}),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue(coachEmail === null ? null : { email: coachEmail }),
    },
  };
}

function buildSvc(prisma: ReturnType<typeof mockPrisma>) {
  const values: Record<string, string> = {
    EMAIL_TRANSPORT: 'resend',
    RESEND_API_KEY: 're_test',
    EMAIL_FROM_ADDRESS: 'team@example.com',
  };
  const db: PrismaService = Object.assign(Object.create(PrismaService.prototype), prisma);
  const config: ConfigService = Object.assign(Object.create(ConfigService.prototype), {
    get: (key: string) => values[key],
  });
  return new EmailService(db, config);
}

const TO_COACH = 'Reply to this email and it goes to your coach.';
const TO_SUPPORT = 'Reply to this email and it goes to The Growth Project support team.';

describe('MONEY-MAIL-128 payment email Reply-To', () => {
  let fetchSpy: jest.SpyInstance;
  beforeEach(() => {
    fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 }));
  });
  afterEach(() => fetchSpy.mockRestore());

  const sentBody = (): { reply_to?: string; html: string } => {
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    return JSON.parse(String(init.body));
  };

  it('a client dunning email replies to the client coach and says so', async () => {
    const prisma = mockPrisma();
    const res = await buildSvc(prisma).send({
      to: 'client@example.com',
      template: EmailTemplateKey.DUNNING_V2_CLIENT,
      data: { roman_body: 'Your card was declined.' },
      idempotencyKey: 'k1',
      replyToCoachUserId: COACH_ID,
    });
    expect(res.status).toBe('sent');
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: COACH_ID },
      select: { email: true },
    });
    const body = sentBody();
    expect(body.reply_to).toBe(COACH_EMAIL);
    expect(body.html).toContain(TO_COACH);
    expect(body.html).not.toContain(TO_SUPPORT);
  });

  it('a payment email with no coach replies to support and says so', async () => {
    const prisma = mockPrisma();
    await buildSvc(prisma).send({
      to: 'guest@example.com',
      template: EmailTemplateKey.PAYMENT_REMINDER,
      data: {},
      idempotencyKey: 'k2',
    });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    const body = sentBody();
    expect(body.reply_to).toBe(SUPPORT_EMAIL);
    expect(body.html).toContain(TO_SUPPORT);
    expect(body.html).not.toContain(TO_COACH);
  });

  it('a coach without an email address falls back to support', async () => {
    await buildSvc(mockPrisma(null)).send({
      to: 'client@example.com',
      template: EmailTemplateKey.PAYMENT_REMINDER_SOFT,
      data: {},
      idempotencyKey: 'k3',
      replyToCoachUserId: COACH_ID,
    });
    const body = sentBody();
    expect(body.reply_to).toBe(SUPPORT_EMAIL);
    expect(body.html).toContain(TO_SUPPORT);
  });

  it('a failed coach lookup still sends, replying to support', async () => {
    const prisma = mockPrisma();
    prisma.user.findUnique.mockRejectedValue(new Error('db down'));
    const res = await buildSvc(prisma).send({
      to: 'client@example.com',
      template: EmailTemplateKey.PAYMENT_FINAL_NOTICE,
      data: {},
      idempotencyKey: 'k4',
      replyToCoachUserId: COACH_ID,
    });
    expect(res.status).toBe('sent');
    expect(sentBody().reply_to).toBe(SUPPORT_EMAIL);
  });

  it('platform emails to a coach reply to support', async () => {
    await buildSvc(mockPrisma()).send({
      to: 'coach@example.com',
      template: EmailTemplateKey.DUNNING_V2_COACH,
      data: { roman_body: 'A payment failed.' },
      idempotencyKey: 'k5',
    });
    const body = sentBody();
    expect(body.reply_to).toBe(SUPPORT_EMAIL);
    expect(body.html).toContain(TO_SUPPORT);
  });

  it('non-payment templates keep their behaviour (no Reply-To, no lookup)', async () => {
    const prisma = mockPrisma();
    await buildSvc(prisma).send({
      to: 'client@example.com',
      template: EmailTemplateKey.COACH_INVITES_CLIENT,
      data: { coach_name: 'Sam' },
      idempotencyKey: 'k6',
      replyToCoachUserId: COACH_ID,
    });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(sentBody().reply_to).toBeUndefined();
  });

  const CLIENT_TEMPLATES = [
    EmailTemplateKey.DUNNING_V2_CLIENT,
    EmailTemplateKey.PAYMENT_REMINDER,
    EmailTemplateKey.PAYMENT_REMINDER_SOFT,
    EmailTemplateKey.PAYMENT_REMINDER_URGENT,
    EmailTemplateKey.PAYMENT_FINAL_NOTICE,
    EmailTemplateKey.DUNNING_FINAL,
  ];
  it.each(CLIENT_TEMPLATES)('%s names where a reply goes in both states', (template) => {
    const svc = buildSvc(mockPrisma());
    const coach = svc.render(template, { reply_to_coach: true }).html;
    const support = svc.render(template, { reply_to_coach: false }).html;
    expect(coach).toContain(TO_COACH);
    expect(coach).not.toContain(TO_SUPPORT);
    expect(support).toContain(TO_SUPPORT);
    expect(support).not.toContain(TO_COACH);
  });

  it.each([EmailTemplateKey.PAYMENT_FAILED, EmailTemplateKey.DUNNING_V2_COACH])(
    '%s (to a coach) says replies go to support',
    (template) => {
      expect(buildSvc(mockPrisma()).render(template, {}).html).toContain(TO_SUPPORT);
    },
  );
});
