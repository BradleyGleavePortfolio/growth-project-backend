import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { EmailService } from '../src/email/email.service';
import { EmailTemplateKey } from '../src/email/email.types';

// Builds a ConfigService stub that returns values from the supplied map.
function mockConfig(values: Record<string, string | undefined>): any {
  return { get: (key: string) => values[key] };
}

function mockPrisma() {
  return {
    emailSendLog: {
      create: jest.fn(),
      update: jest.fn(),
    },
  } as any;
}

describe('EmailService', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  describe('construction / transport selection', () => {
    it('defaults to the log transport when EMAIL_TRANSPORT is unset', () => {
      const svc = new EmailService(mockPrisma(), mockConfig({}));
      expect((svc as any).transportKind).toBe('log');
    });

    it('selects the log transport when EMAIL_TRANSPORT=log', () => {
      const svc = new EmailService(
        mockPrisma(),
        mockConfig({ EMAIL_TRANSPORT: 'log' }),
      );
      expect((svc as any).transportKind).toBe('log');
    });

    it('throws at boot when EMAIL_TRANSPORT=resend and RESEND_API_KEY is unset (no fake email success)', () => {
      expect(
        () =>
          new EmailService(
            mockPrisma(),
            mockConfig({
              EMAIL_TRANSPORT: 'resend',
              EMAIL_FROM_ADDRESS: 'team@example.com',
            }),
          ),
      ).toThrow(/RESEND_API_KEY/);
    });

    it('throws at boot when EMAIL_TRANSPORT=resend and EMAIL_FROM_ADDRESS is unset', () => {
      expect(
        () =>
          new EmailService(
            mockPrisma(),
            mockConfig({
              EMAIL_TRANSPORT: 'resend',
              RESEND_API_KEY: 're_test',
            }),
          ),
      ).toThrow(/EMAIL_FROM_ADDRESS/);
    });

    it('rejects an unsupported transport name', () => {
      expect(
        () =>
          new EmailService(
            mockPrisma(),
            mockConfig({ EMAIL_TRANSPORT: 'sendgrid' }),
          ),
      ).toThrow(/Unsupported EMAIL_TRANSPORT/);
    });

    it('boots cleanly when EMAIL_TRANSPORT=resend and both keys are set', () => {
      const svc = new EmailService(
        mockPrisma(),
        mockConfig({
          EMAIL_TRANSPORT: 'resend',
          RESEND_API_KEY: 're_test',
          EMAIL_FROM_ADDRESS: 'team@example.com',
        }),
      );
      expect((svc as any).transportKind).toBe('resend');
    });
  });

  describe('render', () => {
    it('renders all 8 launch templates without throwing', () => {
      const svc = new EmailService(mockPrisma(), mockConfig({}));
      for (const tpl of Object.values(EmailTemplateKey)) {
        const out = svc.render(tpl, {
          coach_name: 'Coach A',
          recipient_name: 'Alex',
          client_name: 'Alex',
          personal_note: 'see you soon',
          accept_url: 'https://example.com/x',
          invite_code: 'GP-ABC123',
          expires_at: '2026-06-01',
          amount_display: '$49',
          due_date: '2026-06-15',
          attempted_at: '2026-05-10',
          failure_reason: 'card_declined',
          cancellation_date: '2026-06-20',
          billing_portal_url: 'https://example.com/billing',
          console_url: 'https://example.com/console',
          invite_link: 'https://example.com/join/x',
          app_url: 'https://example.com/app',
          checkins_count: 6,
          workouts_count: 4,
          weight_change_display: '-1.4 lbs',
          highlight: 'New PR on bench',
          prefs_url: 'https://example.com/prefs',
          paid_at: '2026-05-01',
          plan_name: 'Coach Pro',
          receipt_number: 'R-100023',
          invoice_url: 'https://example.com/inv',
        });
        expect(typeof out.html).toBe('string');
        expect(out.html.length).toBeGreaterThan(50);
        expect(typeof out.subject).toBe('string');
        expect(out.subject.length).toBeGreaterThan(0);
      }
    });

    it('interpolates coach_name into the coach-invites-client subject', () => {
      const svc = new EmailService(mockPrisma(), mockConfig({}));
      const out = svc.render(EmailTemplateKey.COACH_INVITES_CLIENT, {
        coach_name: 'Sam Trainer',
      });
      expect(out.subject).toBe('Sam Trainer invited you to The Growth Project');
    });
  });

  describe('send (log transport)', () => {
    it('writes a sending row, returns logged, and finalizes to logged', async () => {
      const prisma = mockPrisma();
      prisma.emailSendLog.create.mockResolvedValue({ id: 'row-1' });
      prisma.emailSendLog.update.mockResolvedValue({});
      const svc = new EmailService(prisma, mockConfig({}));
      const res = await svc.send({
        to: 'a@example.com',
        template: EmailTemplateKey.COACH_INVITES_CLIENT,
        idempotencyKey: 'invite:abc',
        data: { coach_name: 'C', invite_code: 'GP-X', accept_url: 'u' },
      });
      expect(res.status).toBe('logged');
      expect(prisma.emailSendLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            idempotency_key: 'invite:abc',
            template_key: 'coach-invites-client',
            recipient_email: 'a@example.com',
            status: 'sending',
          }),
        }),
      );
      expect(prisma.emailSendLog.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'row-1' },
          data: expect.objectContaining({ status: 'logged' }),
        }),
      );
    });

    it('returns skipped when the idempotency key already exists (P2002)', async () => {
      const prisma = mockPrisma();
      const err = new Prisma.PrismaClientKnownRequestError(
        'duplicate',
        { code: 'P2002', clientVersion: '5.0.0' } as any,
      );
      prisma.emailSendLog.create.mockRejectedValue(err);
      const svc = new EmailService(prisma, mockConfig({}));
      const res = await svc.send({
        to: 'a@example.com',
        template: EmailTemplateKey.COACH_INVITES_CLIENT,
        idempotencyKey: 'invite:abc',
        data: { coach_name: 'C', invite_code: 'GP-X', accept_url: 'u' },
      });
      expect(res.status).toBe('skipped');
      expect(prisma.emailSendLog.update).not.toHaveBeenCalled();
    });

    it('throws BadRequestException on an invalid recipient (post-A1-C5-P1-1 hardening)', async () => {
      // Source was hardened (A1-C5-P1-1) to THROW on invalid recipients
      // (no '@', CRLF, or comma-separated addresses) rather than gracefully
      // returning { status: 'failed' }. The throw is the new contract — it
      // surfaces programmer errors loudly instead of silently logging a
      // 'failed' row that callers may never check.
      const prisma = mockPrisma();
      const svc = new EmailService(prisma, mockConfig({}));
      await expect(
        svc.send({
          to: 'not-an-email',
          template: EmailTemplateKey.COACH_INVITES_CLIENT,
          idempotencyKey: 'invite:bad',
          data: {},
        }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        svc.send({
          to: 'not-an-email',
          template: EmailTemplateKey.COACH_INVITES_CLIENT,
          idempotencyKey: 'invite:bad-2',
          data: {},
        }),
      ).rejects.toThrow(/Invalid recipient email address/);
      expect(prisma.emailSendLog.create).not.toHaveBeenCalled();
    });

    it('throws when idempotencyKey is empty (programmer error)', async () => {
      const prisma = mockPrisma();
      const svc = new EmailService(prisma, mockConfig({}));
      await expect(
        svc.send({
          to: 'a@example.com',
          template: EmailTemplateKey.COACH_INVITES_CLIENT,
          idempotencyKey: '',
          data: {},
        }),
      ).rejects.toThrow(/idempotencyKey/);
    });
  });

  describe('send (resend transport)', () => {
    let fetchSpy: jest.SpyInstance;
    beforeEach(() => {
      fetchSpy = jest.spyOn(global, 'fetch' as any);
    });
    afterEach(() => {
      fetchSpy.mockRestore();
    });

    function buildResendSvc(prisma: any) {
      return new EmailService(
        prisma,
        mockConfig({
          EMAIL_TRANSPORT: 'resend',
          RESEND_API_KEY: 're_test',
          EMAIL_FROM_ADDRESS: 'team@example.com',
        }),
      );
    }

    it('posts to Resend and returns sent + provider id on 2xx', async () => {
      const prisma = mockPrisma();
      prisma.emailSendLog.create.mockResolvedValue({ id: 'row-1' });
      prisma.emailSendLog.update.mockResolvedValue({});
      fetchSpy.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ id: 'msg_abc' }),
        text: async () => '',
      } as any);

      const svc = buildResendSvc(prisma);
      const res = await svc.send({
        to: 'a@example.com',
        template: EmailTemplateKey.COACH_INVITES_CLIENT,
        idempotencyKey: 'invite:abc',
        data: { coach_name: 'C', invite_code: 'GP-X', accept_url: 'u' },
      });
      expect(res.status).toBe('sent');
      expect(res.providerMessageId).toBe('msg_abc');
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.resend.com/emails',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer re_test',
          }),
        }),
      );
      expect(prisma.emailSendLog.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'sent',
            provider_message_id: 'msg_abc',
          }),
        }),
      );
    });

    it('returns failed + records error when Resend rejects', async () => {
      const prisma = mockPrisma();
      prisma.emailSendLog.create.mockResolvedValue({ id: 'row-1' });
      prisma.emailSendLog.update.mockResolvedValue({});
      fetchSpy.mockResolvedValue({
        ok: false,
        status: 422,
        json: async () => ({}),
        text: async () => 'domain not verified',
      } as any);

      const svc = buildResendSvc(prisma);
      const res = await svc.send({
        to: 'a@example.com',
        template: EmailTemplateKey.COACH_INVITES_CLIENT,
        idempotencyKey: 'invite:abc',
        data: { coach_name: 'C', invite_code: 'GP-X', accept_url: 'u' },
      });
      expect(res.status).toBe('failed');
      expect(res.error).toMatch(/Resend 422/);
      expect(prisma.emailSendLog.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'failed' }),
        }),
      );
    });
  });
});
