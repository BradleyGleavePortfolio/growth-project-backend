p='src/packages/trials/trial-notice.service.ts'
s=open(p).read()
def rep(old,new,count=1):
    global s
    assert s.count(old)==count, (old[:80], s.count(old))
    s=s.replace(old,new)

rep("""import { NotificationsService } from '../../notifications/notifications.service';
""","""import { NotificationsService } from '../../notifications/notifications.service';
import { resolveRecipientTimeZone } from '../../notifications/recipient-timezone';
""")
rep("""import {
  formatTrialAmount,
  formatTrialDate,""","""import {
  chargeLabel,
  formatTrialAmount,
  formatTrialDate,""")
rep("""//     message but before the outcome write is retried after the lease
//     expires (email retries use a new per-attempt idempotency key only
//     after a definite failure);""","""//     message but before the outcome write is retried after the lease
//     expires. Every email attempt after the first carries its own
//     idempotency key (`:a<attempt>`), so a first send that timed out but
//     did reach the provider can still produce a second email; the lease
//     and the 30 s transport bound keep the two from ever overlapping;""")
rep("""//     removed the card mid-trial is told nothing will be charged (B-656-5).
""","""//     removed the card mid-trial is told nothing will be charged (B-656-5).
//
// B-T12-116 (agent 116) — fix round 6 for Sol B-672-1/2 and Opus B-672-1,
// C-672-1/2/3/5/6:
//   * every channel claim takes its eligibility and its lease from a fresh
//     clock at the claim (the caller's start time plus the time elapsed
//     since), never the sweep's start time, so a row reached late in a slow
//     sweep holds a full lease; a claim whose preparation already used up
//     the room for the bounded transport sends nothing and gives its
//     attempt back (B-672-1 Sol, C-672-1 Opus);
//   * a notice whose purchase was cancelled or is gone is settled 'skipped'
//     (terminal) on both channels, and the retry sweep pages by
//     (created_at, id) with a resumable cursor, so no prefix of skipped,
//     unknown-card or leased rows hides a later notice (B-672-2, C-672-2);
//   * the trial-end date is formatted in main's recipient time zone
//     (resolveRecipientTimeZone: a stamped preference, else the coach's
//     zone); with no usable zone it is the earliest calendar date the end
//     falls on anywhere (UTC-12), so the named date is never a day late
//     (B-672-1 Opus);
//   * "plus any tax" when the subscription has Stripe automatic tax
//     (C-672-5, operator ruling 2026-10-03).
""")
rep("""/** Mobile route the notice opens (Your plan: trial end date + cancel). */
export const TRIAL_ACTION_SCREEN = 'ClientPackages';""","""/**
 * Mobile route the notice should open (Your plan: trial end date + cancel).
 * C-672-3 — mobile main's push-tap router (CLIENT_PUSH_ROUTES) does not list
 * this route yet, so a tap opens Notification Center until the mobile trials
 * piece adds it; the in-app row's deep link (tgp://plan) is unaffected.
 */
export const TRIAL_ACTION_SCREEN = 'ClientPackages';
/**
 * B-672-1 (Opus) — the zone for a trial-end date when no zone is known for
 * the client or their coach: UTC-12, the earliest calendar date anywhere, so
 * the named day is never later than the client's true local end.
 */
export const TRIAL_DATE_FALLBACK_ZONE = 'Etc/GMT+12';""")
rep("""const SWEEP_BATCH = 50;
""","""const SWEEP_BATCH = 50;
/** B-672-2 — pages one retry sweep reads before it resumes from its cursor. */
export const SWEEP_MAX_PAGES = 20;
/** B-672-2 — a sweep stops paging after this and resumes next time. */
export const SWEEP_BUDGET_MS = 8 * 60 * 1000;
""")
rep("""  /** A payment method will really be charged at the trial end. */
  cardOnFile: boolean;
  source: TrialNoticeSource;""","""  /** A payment method will really be charged at the trial end. */
  cardOnFile: boolean;
  /** C-672-5 — Stripe may add tax at the trial end (automatic tax). */
  taxMayApply?: boolean;
  source: TrialNoticeSource;""")
rep("""  cancel_at_period_end?: boolean;
  default_payment_method?: unknown;
  default_source?: unknown;
  items?: {""","""  cancel_at_period_end?: boolean;
  default_payment_method?: unknown;
  default_source?: unknown;
  /** C-672-5 — Stripe automatic tax on the subscription's invoices. */
  automatic_tax?: { enabled?: boolean | null } | null;
  items?: {""")
rep("""/** What the card will be charged when the trial ends, from Stripe's own items. */""","""/** C-672-5 — Stripe may add tax to the trial-end invoice. */
export function subscriptionTaxMayApply(sub: TrialWillEndSubscription): boolean {
  return sub.automatic_tax?.enabled === true;
}

/** What the card will be charged when the trial ends, from Stripe's own items. */""")
rep("""  /** B-656-3 — keyset position when a reconcile sweep hit the page cap. */
  private reconcileCursor: { endsAt: Date; id: string } | null = null;""","""  /** B-656-3 — keyset position when a reconcile sweep hit the page cap. */
  private reconcileCursor: { endsAt: Date; id: string } | null = null;
  /** B-672-2 — keyset position when a retry sweep hit its page/time budget. */
  private sweepCursor: { createdAt: Date; id: string } | null = null;""")
rep("""      cancelAtPeriodEnd: !!sub.cancel_at_period_end,
      cardOnFile,
      source: 'trial_will_end',""","""      cancelAtPeriodEnd: !!sub.cancel_at_period_end,
      cardOnFile,
      taxMayApply: subscriptionTaxMayApply(sub),
      source: 'trial_will_end',""")
rep("""      cancelAtPeriodEnd: !!args.sub.cancel_at_period_end,
      cardOnFile,
      source: 'trial_start',""","""      cancelAtPeriodEnd: !!args.sub.cancel_at_period_end,
      cardOnFile,
      taxMayApply: subscriptionTaxMayApply(args.sub),
      source: 'trial_start',""")
rep("""          stripe_event_id: args.eventId ?? null,
          source: args.source,
        },""","""          stripe_event_id: args.eventId ?? null,
          source: args.source,
          tax_may_apply: args.taxMayApply === true,
        },""")
rep("""    const timeZone = await this.clientTimeZone(purchase.client_user_id, tx);
    const copy = trialEndingCopy({
      trialEndsAt,
      amountCents: args.amountCents,
      currency: args.currency,
      timeZone,
      cancelAtPeriodEnd: args.cancelAtPeriodEnd,
      cardOnFile: args.cardOnFile,
    });""","""    const timeZone = await this.noticeTimeZone(purchase.client_user_id, tx);
    const copy = trialEndingCopy({
      trialEndsAt,
      amountCents: args.amountCents,
      currency: args.currency,
      timeZone,
      cancelAtPeriodEnd: args.cancelAtPeriodEnd,
      cardOnFile: args.cardOnFile,
      taxMayApply: args.taxMayApply === true,
    });""")
rep("""  /** Deliver push + email for a recorded notice. Never throws. */
  async deliver(noticeId: string, now: Date = new Date()): Promise<void> {
    try {
      const notice = await this.prisma.packageTrialNotice.findUnique({ where: { id: noticeId } });
      if (!notice) return;
      if (notice.trial_ends_at.getTime() <= now.getTime()) return;""","""  /**
   * Deliver push + email for a recorded notice. Never throws. `now` is the
   * caller's current time; every claim inside reads a fresh clock from it
   * (B-672-1).
   */
  async deliver(noticeId: string, now: Date = new Date()): Promise<void> {
    const clock = elapsedClock(now);
    try {
      const notice = await this.prisma.packageTrialNotice.findUnique({ where: { id: noticeId } });
      if (!notice) return;
      if (notice.trial_ends_at.getTime() <= clock().getTime()) return;""")
rep("""      if (!purchase || purchase.status === 'canceled') return;
      const timeZone = await this.clientTimeZone(notice.client_user_id);""","""      if (!purchase || purchase.status === 'canceled') {
        // B-672-2 — the notice no longer applies: settle both channels so the
        // row never occupies a retry sweep again.
        await this.settleSkipped(noticeId, purchase ? 'purchase_canceled' : 'purchase_missing');
        return;
      }
      const timeZone = await this.noticeTimeZone(notice.client_user_id);""")
rep("""        cancelAtPeriodEnd: purchase.cancel_at_period_end,
        cardOnFile,
      });
      await this.deliverPush(notice, copy.title, copy.body, now);""","""        cancelAtPeriodEnd: purchase.cancel_at_period_end,
        cardOnFile,
        taxMayApply: notice.tax_may_apply,
      });
      await this.deliverPush(notice, copy.title, copy.body, clock);""")
rep("""          amountLabel: formatTrialAmount(notice.amount_cents, notice.currency),
          cancelAtPeriodEnd: purchase.cancel_at_period_end,
          cardOnFile,
          cadence: cadenceLabel(purchase.package?.interval, purchase.package?.interval_count),
        },
        now,
      );""","""          amountLabel: chargeLabel(
            formatTrialAmount(notice.amount_cents, notice.currency),
            notice.tax_may_apply,
          ),
          cancelAtPeriodEnd: purchase.cancel_at_period_end,
          cardOnFile,
          cadence: cadenceLabel(purchase.package?.interval, purchase.package?.interval_count),
        },
        clock,
      );""")
a=s.index("  @Cron('*/10 * * * *', { name: 'trial-notice-sweep', timeZone: 'UTC' })")
b=s.index("  /**\n   * B-656-3 — started trials (trialing with access)")
s=s[:a]+open('/home/user/workspace/ops/b-t12-116/t2_sweep.ts.txt').read()+s[b:]
rep("""  async reconcileDue(now: Date = new Date()): Promise<number> {
    const horizon""","""  async reconcileDue(now: Date = new Date()): Promise<number> {
    const clock = elapsedClock(now);
    const horizon""")
rep("""      recorded += await this.reconcilePage(candidates, now);""","""      recorded += await this.reconcilePage(candidates, now, clock);""")
rep("""    >,
    now: Date,
  ): Promise<number> {
    const existing""","""    >,
    now: Date,
    clock: () => Date,
  ): Promise<number> {
    const existing""")
rep("""        if (id) {
          recorded += 1;
          await this.deliver(id, now);
        }""","""        if (id) {
          recorded += 1;
          await this.deliver(id, clock());
        }""")
rep("""  private async deliverPush(
    notice: PackageTrialNotice,
    title: string,
    body: string,
    now: Date,
  ): Promise<void> {
    if (notice.push_status !== 'pending' || notice.push_attempts >= TRIAL_NOTICE_MAX_ATTEMPTS)
      return;
    const lease = await this.claim(notice.id, 'push', now);
    if (!lease) return;""","""  private async deliverPush(
    notice: PackageTrialNotice,
    title: string,
    body: string,
    clock: () => Date,
  ): Promise<void> {
    if (notice.push_status !== 'pending' || notice.push_attempts >= TRIAL_NOTICE_MAX_ATTEMPTS)
      return;
    const lease = await this.claim(notice.id, 'push', clock());
    if (!lease) return;""")
rep("""    const prefs = await this.notifications.getPreferences(notice.client_user_id);
    if ((prefs as Record<string, unknown>).muted === true) {""","""    const prefs = await this.notifications.getPreferences(notice.client_user_id);
    // B-672-1 — the preference read may have used up the lease: never start
    // a send the lease cannot cover.
    if (!(await this.leaseCoversSend(notice.id, 'push', lease, clock))) return;
    if ((prefs as Record<string, unknown>).muted === true) {""")
rep("""            // The app's push-tap router (pushTapRouter CLIENT_PUSH_ROUTES) opens
            // Your plan, where the trial end date and the cancel path live.
            actionScreen: TRIAL_ACTION_SCREEN,""","""            // Your plan, where the trial end date and the cancel path live,
            // once the app's push-tap router lists it (C-672-3, see above).
            actionScreen: TRIAL_ACTION_SCREEN,""")
rep("""      cadence: string;
    },
    now: Date,
  ): Promise<void> {""","""      cadence: string;
    },
    clock: () => Date,
  ): Promise<void> {""")
rep("""    const lease = await this.claim(notice.id, 'email', now);
    if (!lease) return;
    if (!ctx.recipient?.email) {
      await this.complete(notice.id, 'email', lease.token, { email_status: 'no_email' });
      return;
    }
    const reason = trialNoChargeReason(ctx);
    // Attempt 1 keeps the original key; a retry after a definite failure gets
    // its own key (EmailService treats a reused key as already sent).""","""    const lease = await this.claim(notice.id, 'email', clock());
    if (!lease) return;
    if (!ctx.recipient?.email) {
      await this.complete(notice.id, 'email', lease.token, { email_status: 'no_email' });
      return;
    }
    if (!(await this.leaseCoversSend(notice.id, 'email', lease, clock))) return;
    const reason = trialNoChargeReason(ctx);
    // Attempt 1 keeps the original key; every later attempt gets its own key
    // (EmailService treats a reused key as already sent). A later attempt
    // starts only after the earlier one ended or its lease expired, so the
    // two never overlap; one that timed out after reaching the provider can
    // still mean a second email (at-least-once, C-672-6).""")
rep("""  private async claim(
    noticeId: string,
    channel: 'push' | 'email',
    now: Date,
  ): Promise<{ token: string; attempt: number } | null> {""","""  private async claim(
    noticeId: string,
    channel: 'push' | 'email',
    now: Date,
  ): Promise<{ token: string; attempt: number; until: Date } | null> {""")
rep("""    return { token, attempt: channel === 'push' ? row.push_attempts : row.email_attempts };
  }""",open('/home/user/workspace/ops/b-t12-116/t2_helpers.ts.txt').read())
a=s.index("  private async clientTimeZone(userId: string, tx?: Tx): Promise<string | null> {")
b=s.index("function firstName(")
s=s[:a]+"""  /**
   * B-672-1 (Opus) — the zone a trial-end date is written in: main's
   * recipient rule (a stamped preference, else the coach's zone), else
   * UTC-12 so the named day is never later than the true local end.
   */
  private async noticeTimeZone(userId: string, tx?: Tx): Promise<string> {
    const zone = await resolveRecipientTimeZone(tx ?? this.prisma, userId);
    return zone ?? TRIAL_DATE_FALLBACK_ZONE;
  }
}

"""+s[b:]
rep("""const TIMED_OUT = Symbol('trial-notice-timeout');""","""/**
 * B-672-1 — a clock that starts at `start` (the caller's notion of now, so
 * tests and replays can pin it) and advances with real elapsed time.
 */
function elapsedClock(start: Date): () => Date {
  const wallAtStart = Date.now();
  return () => new Date(start.getTime() + (Date.now() - wallAtStart));
}

const TIMED_OUT = Symbol('trial-notice-timeout');""")
open(p,'w').write(s)
print("ok")
