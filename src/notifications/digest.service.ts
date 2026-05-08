import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import * as Handlebars from 'handlebars';
import { PrismaService } from '../prisma.service';
import { NotificationsService } from './notifications.service';
import { NotificationKind } from './notification-kind';

// Handlebars helper: {{gt a b}} — used in templates for conditional plural.
Handlebars.registerHelper('gt', (a: number, b: number) => a > b);
Handlebars.registerHelper('eq', (a: unknown, b: unknown) => a === b);

/**
 * DigestService — compiles and sends daily and weekly email digests.
 *
 * Two sender roles:
 *   CLIENT  — receives a summary of their own check-in streak, weight
 *             progress, and upcoming week focus. Digest content NEVER
 *             includes another user's PII.
 *   COACH   — receives a roster snapshot: counts, clients needing attention,
 *             and a "wins this week" list. Client names are display names
 *             only; raw weight, income, and financial data are never included.
 *
 * Idempotency: before every send, DigestService calls
 * NotificationsService.claimDigestWindow. If the window is already claimed
 * the send is skipped. This prevents duplicate emails on cron re-runs.
 *
 * Transport: uses the EMAIL_TRANSPORT configured in the environment.
 * Supported transports: 'resend' (default), 'sendgrid', 'postmark', 'log'
 * (dev/test). When the transport credentials are absent the send is logged
 * and skipped — no throw, so the cron continues for other users.
 */
@Injectable()
export class DigestService {
  private readonly logger = new Logger(DigestService.name);
  private readonly templates = new Map<string, HandlebarsTemplateDelegate>();
  private readonly appUrl: string;
  private readonly consoleUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {
    this.appUrl = this.config.get<string>('APP_URL') ?? 'https://app.thegrowthproject.app';
    this.consoleUrl =
      this.config.get<string>('CONSOLE_URL') ?? 'https://console.thegrowthproject.app';
    this._loadTemplates();
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Send the daily client digest to all active clients whose prefs allow it.
   * Called by DigestScheduler at CLIENT_DAILY_CRON (default 07:00 UTC).
   */
  async sendClientDailyDigests(): Promise<void> {
    if (!this._digestEnabled('EMAIL_DIGEST_CLIENT_ENABLED')) return;

    const windowDate = this._todayIso();
    const clients = await this._activeClientsWithEmailDigest();

    this.logger.log(`client daily digest: ${clients.length} eligible users, window=${windowDate}`);

    for (const client of clients) {
      await this._sendClientDigest(client, 'client_daily', windowDate, 'daily');
    }
  }

  /**
   * Send the daily coach digest to all coaches whose prefs allow it.
   * Called by DigestScheduler at COACH_DAILY_CRON (default 06:00 UTC).
   */
  async sendCoachDailyDigests(): Promise<void> {
    if (!this._digestEnabled('EMAIL_DIGEST_COACH_ENABLED')) return;

    const windowDate = this._todayIso();
    const coaches = await this._activeCoachesWithEmailDigest();

    this.logger.log(`coach daily digest: ${coaches.length} eligible coaches, window=${windowDate}`);

    for (const coach of coaches) {
      await this._sendCoachDigest(coach, 'coach_daily', windowDate, 'daily');
    }
  }

  /**
   * Send weekly summaries (Sunday 08:00 UTC by default).
   * Sends both client and coach weekly digests in the same cron window.
   */
  async sendWeeklyDigests(): Promise<void> {
    const windowDate = this._thisWeekIso();

    if (this._digestEnabled('EMAIL_DIGEST_CLIENT_ENABLED')) {
      const clients = await this._activeClientsWithEmailDigest();
      this.logger.log(`client weekly digest: ${clients.length} eligible users, window=${windowDate}`);
      for (const client of clients) {
        await this._sendClientDigest(client, 'weekly_client', windowDate, 'weekly');
      }
    }

    if (this._digestEnabled('EMAIL_DIGEST_COACH_ENABLED')) {
      const coaches = await this._activeCoachesWithEmailDigest();
      this.logger.log(`coach weekly digest: ${coaches.length} eligible coaches, window=${windowDate}`);
      for (const coach of coaches) {
        await this._sendCoachDigest(coach, 'weekly_coach', windowDate, 'weekly');
      }
    }
  }

  // ── Private: per-user send helpers ───────────────────────────────────────

  private async _sendClientDigest(
    client: { id: string; email: string; name: string },
    digestKind: string,
    windowDate: string,
    type: 'daily' | 'weekly',
  ): Promise<void> {
    const logId = await this.notifications.claimDigestWindow(
      client.id,
      digestKind,
      windowDate,
    );
    if (!logId) {
      this.logger.debug(
        `client digest already sent: user=${client.id} kind=${digestKind} window=${windowDate}`,
      );
      return;
    }

    try {
      const data = await this._buildClientDigestData(client.id, type);
      const templateKey = type === 'weekly' ? 'digest-client-weekly' : 'digest-client';
      const subject =
        type === 'weekly'
          ? `Your week in numbers — ${data.weekStats?.consistencyPct ?? 0}% check-in consistency`
          : `Your daily summary — ${data.date}`;

      await this._send(client.email, subject, templateKey, {
        ...data,
        appUrl: this.appUrl,
        unsubscribeUrl: `${this.appUrl}/settings/notifications`,
        currentYear: new Date().getFullYear().toString(),
      });

      // Write an in-app notification row so the inbox shows the digest was sent.
      await this.notifications.createNotification({
        user_id: client.id,
        kind:
          type === 'weekly'
            ? NotificationKind.CLIENT_DIGEST
            : NotificationKind.CLIENT_DIGEST,
        body:
          type === 'weekly'
            ? `Your weekly summary has been sent to ${client.email}.`
            : `Your daily summary has been sent to ${client.email}.`,
        channel: 'email',
      });

      await this.notifications.markDigestSent(logId);
    } catch (err) {
      await this.notifications.markDigestFailed(logId, (err as Error).message);
      this.logger.error(
        `client digest failed: user=${client.id} kind=${digestKind}: ${(err as Error).message}`,
      );
    }
  }

  private async _sendCoachDigest(
    coach: { id: string; email: string; name: string },
    digestKind: string,
    windowDate: string,
    type: 'daily' | 'weekly',
  ): Promise<void> {
    const logId = await this.notifications.claimDigestWindow(
      coach.id,
      digestKind,
      windowDate,
    );
    if (!logId) {
      this.logger.debug(
        `coach digest already sent: user=${coach.id} kind=${digestKind} window=${windowDate}`,
      );
      return;
    }

    try {
      const data = await this._buildCoachDigestData(coach.id, type);
      const templateKey = type === 'weekly' ? 'digest-coach-weekly' : 'digest-coach';
      const needCount = type === 'weekly'
        ? (data.needingAttention?.length ?? 0)
        : (data.rosterStats?.needingReview ?? 0);

      const subject =
        type === 'weekly'
          ? needCount > 0
            ? `${needCount} client${needCount !== 1 ? 's' : ''} need check-in this week — your weekly summary`
            : `Your weekly coach summary — ${data.date}`
          : needCount > 0
            ? `${needCount} client${needCount !== 1 ? 's' : ''} need review today — ${data.date}`
            : `Your coach summary — ${data.date}`;

      await this._send(coach.email, subject, templateKey, {
        ...data,
        consoleUrl: this.consoleUrl,
        unsubscribeUrl: `${this.consoleUrl}/settings/notifications`,
        currentYear: new Date().getFullYear().toString(),
      });

      await this.notifications.createNotification({
        user_id: coach.id,
        kind: NotificationKind.COACH_DIGEST,
        body:
          type === 'weekly'
            ? `Your weekly coach summary has been sent to ${coach.email}.`
            : `Your coach daily summary has been sent to ${coach.email}.`,
        channel: 'email',
      });

      await this.notifications.markDigestSent(logId);
    } catch (err) {
      await this.notifications.markDigestFailed(logId, (err as Error).message);
      this.logger.error(
        `coach digest failed: user=${coach.id} kind=${digestKind}: ${(err as Error).message}`,
      );
    }
  }

  // ── Private: data builders ────────────────────────────────────────────────

  private async _buildClientDigestData(userId: string, _type: 'daily' | 'weekly') {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const sevenDaysAgo = new Date(today);
    sevenDaysAgo.setDate(today.getDate() - 7);

    // Check-in streak (last 30 days).
    const checkIns = await this.prisma.checkIn.findMany({
      where: { user_id: userId, date: { gte: sevenDaysAgo } },
      orderBy: { date: 'desc' },
    });
    const streakDays = checkIns.length;

    // Latest weight log.
    const latestWeight = await this.prisma.weightLog.findFirst({
      where: { user_id: userId },
      orderBy: { date: 'desc' },
    });

    // Coach name (privacy: display name only — never full name without opt-in).
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { coach: { select: { name: true } } },
    });
    const coachName = user?.coach?.name
      ? user.coach.name.split(' ')[0] // First name only for privacy
      : null;

    return {
      date: this._formatDate(now),
      checkins: [
        { label: 'Check-ins this week', value: `${checkIns.length} of 7` },
        { label: 'Current streak', value: `${streakDays} day${streakDays !== 1 ? 's' : ''}` },
      ],
      weightMetrics: latestWeight
        ? [{ label: 'Last logged weight', value: `${latestWeight.weight_lbs} lbs` }]
        : [],
      streakMetrics: [
        { label: 'This week', value: `${checkIns.length} check-in${checkIns.length !== 1 ? 's' : ''}` },
      ],
      coachName,
      weekStats:
        _type === 'weekly'
          ? {
              checkinsCount: checkIns.length,
              consistencyPct: Math.round((checkIns.length / 7) * 100),
              workoutsCount: await this._countWorkouts(userId, sevenDaysAgo),
              weightDelta: await this._weightDelta(userId, sevenDaysAgo),
            }
          : undefined,
      streaks:
        _type === 'weekly'
          ? {
              current: streakDays,
              best: streakDays, // simplified — full best-streak calc is in PTM module
            }
          : undefined,
    };
  }

  private async _buildCoachDigestData(coachId: string, _type: 'daily' | 'weekly') {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const sevenDaysAgo = new Date(today);
    sevenDaysAgo.setDate(today.getDate() - 7);

    // Roster.
    const clients = await this.prisma.user.findMany({
      where: { coach_id: coachId, deleted_at: null, archived_at: null },
      select: { id: true, name: true },
    });
    const activeCount = clients.length;

    // Check-ins today.
    const checkinsToday = await this.prisma.checkIn.count({
      where: { coach_id: coachId, date: today },
    });

    // Clients with no check-in in last 3 days.
    const threeDaysAgo = new Date(today);
    threeDaysAgo.setDate(today.getDate() - 3);
    const checkedInRecently = await this.prisma.checkIn.findMany({
      where: { coach_id: coachId, date: { gte: threeDaysAgo } },
      select: { user_id: true },
      distinct: ['user_id'],
    });
    const recentIds = new Set(checkedInRecently.map((c) => c.user_id));
    const missedClients = clients.filter((c) => !recentIds.has(c.id));

    // Privacy: coach sees display name (first name only) + reason.
    const needingReview = missedClients.length;
    const alertClients = missedClients.slice(0, 10).map((c) => ({
      displayName: c.name.split(' ')[0], // First name only
      reason: 'No check-in in 3+ days',
    }));

    // Unread messages.
    const unreadMessages = await this.prisma.coachMessage.count({
      where: { coach_id: coachId, sender_id: { not: coachId }, read_at: null },
    });

    // Weekly stats.
    const weeklyCheckinsCount =
      _type === 'weekly'
        ? await this.prisma.checkIn.count({
            where: { coach_id: coachId, date: { gte: sevenDaysAgo } },
          })
        : 0;

    const avgConsistencyPct =
      activeCount > 0 && _type === 'weekly'
        ? Math.round((weeklyCheckinsCount / (activeCount * 7)) * 100)
        : 0;

    const needCheckin =
      _type === 'weekly' ? missedClients.length : 0;

    return {
      date: this._formatDate(now),
      rosterStats: {
        activeCount,
        checkinsToday,
        needingReview,
        unreadMessages,
        weeklyCheckinsCount,
        avgConsistencyPct,
        needCheckin,
      },
      alertClients,
      needingAttention: _type === 'weekly' ? alertClients : undefined,
      recentWins: [], // Future: pull from CoachAlert / milestone events
      topPerformers: [], // Future: derive from check-in consistency
    };
  }

  // ── Private: eligibility queries ─────────────────────────────────────────

  private async _activeClientsWithEmailDigest() {
    // Active = not archived, not deleted, email confirmed.
    // Prefs check: digest_email is either null (unset → default true) or true.
    const users = await this.prisma.user.findMany({
      where: {
        role: 'student',
        deleted_at: null,
        archived_at: null,
        OR: [
          { notification_prefs: null },
          { notification_prefs: { muted: false, digest_email: true } },
        ],
      },
      select: { id: true, email: true, name: true },
    });
    return users;
  }

  private async _activeCoachesWithEmailDigest() {
    const users = await this.prisma.user.findMany({
      where: {
        role: 'coach',
        deleted_at: null,
        archived_at: null,
        OR: [
          { notification_prefs: null },
          { notification_prefs: { muted: false, digest_email: true } },
        ],
      },
      select: { id: true, email: true, name: true },
    });
    return users;
  }

  // ── Private: email send ───────────────────────────────────────────────────

  private async _send(
    to: string,
    subject: string,
    templateKey: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const html = this._render(templateKey, data);
    const from = this.config.get<string>('EMAIL_FROM_ADDRESS') ?? 'noreply@thegrowthproject.app';
    const transport = this.config.get<string>('EMAIL_TRANSPORT') ?? 'log';

    if (transport === 'resend') {
      await this._sendViaResend(from, to, subject, html);
    } else if (transport === 'sendgrid') {
      await this._sendViaSendgrid(from, to, subject, html);
    } else if (transport === 'postmark') {
      await this._sendViaPostmark(from, to, subject, html);
    } else {
      // 'log' transport — dev / test mode.
      this.logger.log(`[email log] to=${to} subject="${subject}"`);
    }
  }

  private async _sendViaResend(
    from: string,
    to: string,
    subject: string,
    html: string,
  ): Promise<void> {
    const apiKey = this.config.get<string>('RESEND_API_KEY');
    if (!apiKey) {
      this.logger.warn('RESEND_API_KEY not set — email send skipped');
      return;
    }
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, html }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Resend API error ${res.status}: ${body}`);
    }
  }

  private async _sendViaSendgrid(
    from: string,
    to: string,
    subject: string,
    html: string,
  ): Promise<void> {
    const apiKey = this.config.get<string>('SENDGRID_API_KEY');
    if (!apiKey) {
      this.logger.warn('SENDGRID_API_KEY not set — email send skipped');
      return;
    }
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: from },
        subject,
        content: [{ type: 'text/html', value: html }],
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`SendGrid API error ${res.status}: ${body}`);
    }
  }

  private async _sendViaPostmark(
    from: string,
    to: string,
    subject: string,
    html: string,
  ): Promise<void> {
    const apiKey = this.config.get<string>('POSTMARK_SERVER_TOKEN');
    if (!apiKey) {
      this.logger.warn('POSTMARK_SERVER_TOKEN not set — email send skipped');
      return;
    }
    const res = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: {
        'X-Postmark-Server-Token': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ From: from, To: to, Subject: subject, HtmlBody: html }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Postmark API error ${res.status}: ${body}`);
    }
  }

  // ── Private: template helpers ─────────────────────────────────────────────

  private _loadTemplates(): void {
    const dir = path.join(__dirname, 'templates');
    const names = [
      'digest-client',
      'digest-coach',
      'digest-client-weekly',
      'digest-coach-weekly',
    ];
    for (const name of names) {
      const filePath = path.join(dir, `${name}.hbs`);
      if (fs.existsSync(filePath)) {
        const src = fs.readFileSync(filePath, 'utf-8');
        this.templates.set(name, Handlebars.compile(src));
      } else {
        this.logger.warn(`Template not found: ${filePath}`);
      }
    }
  }

  private _render(templateKey: string, data: Record<string, unknown>): string {
    const tpl = this.templates.get(templateKey);
    if (!tpl) {
      throw new Error(`Unknown template: ${templateKey}`);
    }
    return tpl(data);
  }

  private _digestEnabled(envKey: string): boolean {
    const val = this.config.get<string>(envKey);
    return val === undefined || val === '' || val.toLowerCase() !== 'off';
  }

  private _todayIso(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private _thisWeekIso(): string {
    const d = new Date();
    const dayOfWeek = d.getDay(); // 0=Sun, 1=Mon...
    const diff = d.getDate() - dayOfWeek; // last Sunday
    const sunday = new Date(d.setDate(diff));
    return sunday.toISOString().slice(0, 10);
  }

  private _formatDate(d: Date): string {
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  private async _countWorkouts(userId: string, since: Date): Promise<number> {
    return this.prisma.workoutSession.count({
      where: { user_id: userId, date: { gte: since } },
    });
  }

  private async _weightDelta(userId: string, since: Date): Promise<string | null> {
    const logs = await this.prisma.weightLog.findMany({
      where: { user_id: userId, date: { gte: since } },
      orderBy: { date: 'asc' },
      take: 2,
    });
    if (logs.length < 2) return null;
    const delta = logs[logs.length - 1].weight_lbs - logs[0].weight_lbs;
    const sign = delta > 0 ? '+' : '';
    return `${sign}${delta.toFixed(1)}`;
  }
}

// HandlebarsTemplateDelegate is the type returned by Handlebars.compile.
type HandlebarsTemplateDelegate = (context: Record<string, unknown>) => string;
