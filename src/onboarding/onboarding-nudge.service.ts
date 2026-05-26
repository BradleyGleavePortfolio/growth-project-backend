/**
 * OnboardingNudgeService — R51 first-client nudge engine.
 *
 * Responsibilities (separated from the scheduler so it can be unit-
 * tested without booting cron):
 *
 *   - detectMilestone(coachId) — live read of packages / share-links /
 *     leads / clients, returns the most-advanced milestone the coach
 *     has reached.  Pure-read; never writes.
 *   - ensureState(coachId) — lazily creates CoachOnboardingState the
 *     first time we see a coach (uses User.created_at as the signup
 *     anchor so the same row is reproducible across reboots).
 *   - sendNudge(state, day) — runs the milestone detector, picks the
 *     copy via nudge-content.pickNudge, fires the in-app notification +
 *     email send, and flips the day_N_sent boolean. Idempotent on
 *     (coach_id, day) — re-running for an already-sent day is a no-op.
 *   - markFirstClient(coachId) — terminal transition called by upstream
 *     payment / GuestCheckout conversion code.  Sets first_client_at +
 *     last_milestone='first_client' so the scheduler stops sending.
 *
 * Per-coach work runs through try/catch so one coach's email-render or
 * push failure cannot wedge the daily dispatch.
 */

import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CoachOnboardingState, OnboardingMilestone } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { EmailService } from '../email/email.service';
import { EmailTemplateKey } from '../email/email.types';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationKind } from '../notifications/notification-kind';
import { buildShareTemplates, type ShareTemplate } from './share-templates';
import { pickNudge, type NudgeDay, type NudgeTokens } from './nudge-content';

const SUPPORT_BOOK_URL_DEFAULT = 'mailto:bradley@trygrowthproject.com';
const CONSOLE_URL_DEFAULT = 'https://app.trygrowthproject.com/coach';

@Injectable()
export class OnboardingNudgeService {
  private readonly logger = new Logger(OnboardingNudgeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  // ─── State management ──────────────────────────────────────────────────────

  /**
   * Lazily create a CoachOnboardingState row for a coach.  Uses the
   * coach's User.created_at as the signup anchor — copying it ensures
   * the day arithmetic is stable across reboots and independent of any
   * future mutations to User.created_at.
   */
  async ensureState(coachId: string): Promise<CoachOnboardingState> {
    const existing = await this.prisma.coachOnboardingState.findUnique({
      where: { coach_id: coachId },
    });
    if (existing) return existing;
    const user = await this.prisma.user.findUnique({
      where: { id: coachId },
      select: { id: true, role: true, created_at: true },
    });
    if (!user) throw new NotFoundException({ error: 'COACH_NOT_FOUND' });
    if (user.role !== 'coach' && user.role !== 'owner') {
      throw new BadRequestException({ error: 'NOT_A_COACH' });
    }
    return this.prisma.coachOnboardingState.create({
      data: {
        coach_id: coachId,
        signup_at: user.created_at,
      },
    });
  }

  /**
   * Read-only — used by GET /v1/coaches/me/onboarding/state.  Creates
   * the row lazily so the first-ever read after this PR ships does not
   * 404 for an existing coach.
   */
  async getStateForCoach(coachId: string): Promise<CoachOnboardingState> {
    return this.ensureState(coachId);
  }

  /**
   * Coach-triggered opt-out.  Idempotent — repeated calls update the
   * timestamp to "first opt-out" so analytics can join on a stable value.
   */
  async optOut(coachId: string): Promise<CoachOnboardingState> {
    const state = await this.ensureState(coachId);
    if (state.opted_out_at) return state;
    return this.prisma.coachOnboardingState.update({
      where: { id: state.id },
      data: { opted_out_at: new Date() },
    });
  }

  /**
   * Called by upstream payment / conversion code when a coach lands
   * their first paying client.  Idempotent (a second call is a no-op
   * because first_client_at is already set on the row).
   */
  async markFirstClient(coachId: string, when: Date = new Date()): Promise<void> {
    const state = await this.prisma.coachOnboardingState.findUnique({
      where: { coach_id: coachId },
    });
    if (!state) return; // nothing to update — row will be created next tick
    if (state.first_client_at) return; // already terminal
    await this.prisma.coachOnboardingState.update({
      where: { id: state.id },
      data: {
        first_client_at: when,
        last_milestone: 'first_client',
      },
    });
  }

  // ─── Milestone detection ───────────────────────────────────────────────────

  /**
   * Resolve the coach's CURRENT milestone via three read queries:
   *
   *   1. ClientPurchase / GuestCheckout converted → first_client
   *   2. CoachLandingLead exists                  → first_lead
   *   3. CoachPackage with share_token            → shared_link
   *   4. CoachPackage exists                      → created_package
   *   5. nothing                                  → signed_up
   *
   * Cheap — every query is indexed on coach_id and we only fetch
   * count/exists, not the whole row.  Called once per coach per day on
   * the scheduler tick (and from getStateForCoach for the in-app
   * progress strip).
   */
  async detectMilestone(coachId: string): Promise<OnboardingMilestone> {
    // 1. Most advanced state: paying client.  We accept both the in-app
    //    ClientPurchase path AND the storefront GuestCheckout path
    //    (latter linked back via package.coach_id).
    const clientCount = await this.prisma.clientPurchase.count({
      where: {
        coach_user_id: coachId,
        entitlement_active: true,
      },
    });
    if (clientCount > 0) return 'first_client';

    // 2. Lead in the funnel: any CoachLandingLead row for the coach.
    const leadCount = await this.prisma.coachLandingLead.count({
      where: { coach_id: coachId },
    });
    if (leadCount > 0) return 'first_lead';

    // 3 + 4. Package state.  Fetch the most recent package once and
    // branch on share_token presence to avoid two queries.
    const pkg = await this.prisma.coachPackage.findFirst({
      where: { coach_id: coachId },
      select: { id: true, share_token: true },
      orderBy: { created_at: 'desc' },
    });
    if (pkg?.share_token) return 'shared_link';
    if (pkg) return 'created_package';

    return 'signed_up';
  }

  // ─── Share templates ───────────────────────────────────────────────────────

  /**
   * Build the share-template array for the GET endpoint and the Day-2
   * email body.  Returns an empty array if the coach has no package
   * with a share_token yet — the controller maps that to a 404-style
   * empty list and the day-2 email branches to a different copy.
   */
  async buildShareTemplatesForCoach(coachId: string): Promise<ShareTemplate[]> {
    const [user, pkg] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: coachId },
        select: { name: true },
      }),
      this.prisma.coachPackage.findFirst({
        where: { coach_id: coachId, share_token: { not: null } },
        select: { share_token: true },
        orderBy: { share_link_generated_at: 'desc' },
      }),
    ]);
    if (!pkg?.share_token) return [];
    const base =
      this.config.get<string>('STOREFRONT_BASE_URL') ||
      'https://joingrowthproject.com';
    const shareUrl = `${base.replace(/\/$/, '')}/v1/packages/public/join/${pkg.share_token}`;
    return buildShareTemplates({
      coachFirstName: firstNameOf(user?.name ?? null),
      shareUrl,
    });
  }

  // ─── Send pipeline ─────────────────────────────────────────────────────────

  /**
   * Run the dispatch for a single (coach, day) pair.  Guards:
   *   - row exists, not opted out, not past first_client
   *   - day_N_sent flag is not already true
   *   - email recipient exists
   *
   * Returns whether a nudge was actually fired (false = no-op).
   */
  async sendNudge(coachId: string, day: NudgeDay): Promise<boolean> {
    const state = await this.prisma.coachOnboardingState.findUnique({
      where: { coach_id: coachId },
    });
    if (!state) return false;
    if (state.opted_out_at) return false;
    if (state.first_client_at) return false;
    if (this.dayAlreadySent(state, day)) return false;

    const milestone = await this.detectMilestone(coachId);

    // If the live milestone is first_client, persist the terminal
    // transition and stop — the scheduler may have raced an upstream
    // markFirstClient call.
    if (milestone === 'first_client') {
      await this.prisma.coachOnboardingState.update({
        where: { id: state.id },
        data: {
          first_client_at: new Date(),
          last_milestone: 'first_client',
        },
      });
      return false;
    }

    const [user, snippets] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: coachId },
        select: { id: true, name: true, email: true },
      }),
      day === 2 ? this.buildShareTemplatesForCoach(coachId) : Promise.resolve([] as ShareTemplate[]),
    ]);
    if (!user) return false;

    const firstName = firstNameOf(user.name);
    const shareUrl = await this.resolveShareUrl(coachId);

    const tokens: NudgeTokens = {
      coach_first_name: firstName,
      share_url: shareUrl,
      console_url: this.consoleUrl(),
      support_url: this.supportUrl(),
      share_snippets: snippets.map((s) => ({ label: s.label, copy: s.copy })),
    };

    const content = pickNudge({ day, milestone, tokens });
    if (!content) return false;

    // ─ In-app notification (gated by NotificationPreferences in the service)
    try {
      await this.notifications.createNotification({
        user_id: coachId,
        kind: NotificationKind.ONBOARDING_NUDGE,
        body: content.in_app,
        deep_link: content.deep_link,
        channel: 'inapp',
        payload: { day, milestone },
      });
    } catch (err) {
      // Never block the email path on a notification failure — the
      // email is the higher-confidence channel here.
      this.logger.warn(
        `onboarding nudge inapp create failed coach=${coachId} day=${day}: ${errorMessage(err)}`,
      );
    }

    // ─ Email send (idempotent on key `onboarding-nudge:<coach>:<day>`).
    if (user.email) {
      try {
        await this.email.send({
          to: user.email,
          template: EmailTemplateKey.FIRST_CLIENT_NUDGE_V1,
          idempotencyKey: `onboarding-nudge:${coachId}:${day}`,
          data: {
            subject: content.subject,
            body_html: content.email_html,
            opt_out_url: this.optOutUrl(),
          },
        });
      } catch (err) {
        this.logger.error(
          `onboarding nudge email send failed coach=${coachId} day=${day}: ${errorMessage(err)}`,
        );
        // Fall through — still mark the day as sent so we don't loop
        // on a permanently broken recipient. Email log retains the
        // failed status for ops.
      }
    }

    // ─ Mark the day as sent + update last_milestone snapshot.
    const now = new Date();
    await this.prisma.coachOnboardingState.update({
      where: { id: state.id },
      data: {
        ...this.dayFlagPatch(day, now),
        last_milestone: milestone,
      },
    });
    return true;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /**
   * The day-N boolean check.  Pulled out so a future change in field
   * naming touches one place.
   */
  private dayAlreadySent(state: CoachOnboardingState, day: NudgeDay): boolean {
    switch (day) {
      case 1: return state.day_1_sent;
      case 2: return state.day_2_sent;
      case 3: return state.day_3_sent;
      case 5: return state.day_5_sent;
      case 7: return state.day_7_sent;
    }
  }

  private dayFlagPatch(day: NudgeDay, when: Date): Partial<CoachOnboardingState> {
    switch (day) {
      case 1: return { day_1_sent: true, day_1_sent_at: when } as never;
      case 2: return { day_2_sent: true, day_2_sent_at: when } as never;
      case 3: return { day_3_sent: true, day_3_sent_at: when } as never;
      case 5: return { day_5_sent: true, day_5_sent_at: when } as never;
      case 7: return { day_7_sent: true, day_7_sent_at: when } as never;
    }
  }

  private async resolveShareUrl(coachId: string): Promise<string | null> {
    const pkg = await this.prisma.coachPackage.findFirst({
      where: { coach_id: coachId, share_token: { not: null } },
      select: { share_token: true },
      orderBy: { share_link_generated_at: 'desc' },
    });
    if (!pkg?.share_token) return null;
    const base =
      this.config.get<string>('STOREFRONT_BASE_URL') ||
      'https://joingrowthproject.com';
    return `${base.replace(/\/$/, '')}/v1/packages/public/join/${pkg.share_token}`;
  }

  private consoleUrl(): string {
    return (
      this.config.get<string>('PUBLIC_APP_BASE_URL') ||
      CONSOLE_URL_DEFAULT
    );
  }

  private supportUrl(): string {
    return (
      this.config.get<string>('ONBOARDING_SUPPORT_BOOK_URL') ||
      SUPPORT_BOOK_URL_DEFAULT
    );
  }

  private optOutUrl(): string {
    const base = this.consoleUrl().replace(/\/$/, '');
    return `${base}/coach/settings/notifications`;
  }
}

// ─── Free helpers (also imported by spec files) ───────────────────────────────

export function firstNameOf(fullName: string | null): string {
  if (!fullName) return 'there';
  const first = fullName.trim().split(/\s+/)[0];
  return first?.trim() || 'there';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
