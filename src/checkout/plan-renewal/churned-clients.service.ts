import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { User } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { AiGatewayService } from '../../ai/gateway/ai-gateway.service';
import { PrivateContextService } from '../../ai/gateway/private-context.service';
import { sanitizePromptInput } from '../../ai/utils/sanitize-prompt-input';
import { clientWeek } from '../../coach/client-week';
import type { HomeWinDraft } from '../../coach/command-center/coach-home-day';
import { firstNameOf } from '../../engagement/welcome-template';
import { resolveRecipientTimeZone } from '../../notifications/recipient-timezone';
import { planEndedAt } from './plan-renewal.service';
import { endedPlanWhere, planRenewalBlock } from './plan-renewal.state';

/** CHURN-BE: a client is listed while their plan's end is at most this many days old (operator default, owner-tunable). */
export const CHURNED_CLIENTS_WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;

export interface ChurnedClientRow {
  client_id: string;
  /** As the coach's client list shows them: the first word of the name, the profile photo. */
  first_name: string | null;
  name: string;
  avatar_url: string | null;
  ended_at: string;
  /** The day the plan ended in the coach's time zone (YYYY-MM-DD). */
  ended_on: string;
  /** Coach's days from `ended_on` to today (0 = ended today). */
  days_since: number;
  /** today, this_week (the coach's Monday-to-Sunday week, before today) or earlier. */
  group: 'today' | 'this_week' | 'earlier';
  package_name: string;
  /** The coach side's latest chat message to the client after the end (a person sent it), or null. */
  last_coach_message_at: string | null;
}

export interface ChurnedClientsPage {
  time_zone: string;
  /** The coach's today (YYYY-MM-DD). */
  today: string;
  /** Rows in the `today` group across every page. */
  today_count: number;
  items: ChurnedClientRow[];
  next_cursor: string | null;
}

interface Churned {
  clientId: string;
  endedAt: Date;
  packageName: string;
}

type Caller = Pick<User, 'id' | 'role' | 'coach_id'>;

const notFound = () =>
  new NotFoundException({ code: 'CHURNED_CLIENT_NOT_FOUND', error: 'CHURNED_CLIENT_NOT_FOUND', message: 'This client is not on your churned list.' });

/**
 * CHURN-BE: the coach's churned clients and Roman's win-back draft (FEATURE_PLAN_RENEWAL).
 *
 * A client is churned when their latest plan with this coach ended normally in
 * the window and planRenewalBlock (the renewal sequence's one rule) still lets
 * a renewal run: not moved, archived, revoked, deleted or deleting, no active
 * plan with the coach, no refund or dispute, no open failed payment.
 */
@Injectable()
export class ChurnedClientsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: PrivateContextService,
    private readonly gateway: AiGatewayService,
  ) {}

  /** The coach's churned clients, newest end first, paged like GET /coach/clients (cursor, take: 20, at most 50). */
  async list(coachId: string, cursor?: string, takeRaw?: string, now = new Date()): Promise<ChurnedClientsPage> {
    const after = cursor ? /^(\d{1,15})\.(.+)$/.exec(cursor) : null;
    if (cursor && !after) {
      throw new BadRequestException({ code: 'CHURNED_CLIENTS_CURSOR_INVALID', error: 'CHURNED_CLIENTS_CURSOR_INVALID', message: 'cursor is not valid.' });
    }
    const take = Math.max(1, Math.min(parseInt(takeRaw ?? '', 10) || 20, 50));
    const [week, all] = await Promise.all([this.coachWeek(coachId, now), this.churned(coachId, now)]);
    const start = after
      ? all.findIndex((r) => r.endedAt.getTime() < Number(after[1]) || (r.endedAt.getTime() === Number(after[1]) && r.clientId > after[2]))
      : 0;
    const page = start < 0 ? [] : all.slice(start, start + take);
    const ids = page.map((r) => r.clientId);
    const [users, messages] = await Promise.all([
      this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, profile: { select: { avatar_url: true } } } }),
      // As the coach Home counts a reach-out: a person on the coach side sent it
      // (not a broadcast copy, not an automated message), and it is not deleted.
      this.prisma.coachMessage.findMany({
        where: {
          coach_id: coachId,
          client_id: { in: ids },
          sender_id: { notIn: ids },
          deleted_at: null,
          broadcast_delivery: { is: null },
          automated_by: null,
          OR: page.map((r) => ({ client_id: r.clientId, created_at: { gt: r.endedAt } })),
        },
        orderBy: [{ client_id: 'asc' }, { created_at: 'desc' }],
        distinct: ['client_id'],
        select: { client_id: true, created_at: true },
      }),
    ]);
    const user = new Map(users.map((x) => [x.id, x]));
    const last = new Map(messages.map((m) => [m.client_id ?? '', m.created_at]));
    const items = page.map((r): ChurnedClientRow => {
      const who = user.get(r.clientId);
      const ended_on = week.dayOf(r.endedAt);
      return {
        client_id: r.clientId,
        first_name: firstNameOf(who?.name),
        name: who?.name ?? '',
        avatar_url: who?.profile?.avatar_url ?? null,
        ended_at: r.endedAt.toISOString(),
        ended_on,
        days_since: week.daysSince(r.endedAt),
        group: ended_on === week.today ? 'today' : r.endedAt >= week.from ? 'this_week' : 'earlier',
        package_name: r.packageName,
        last_coach_message_at: last.get(r.clientId)?.toISOString() ?? null,
      };
    });
    const tail = page[page.length - 1];
    return {
      time_zone: week.tz,
      today: week.today,
      today_count: all.filter((r) => week.dayOf(r.endedAt) === week.today).length,
      items,
      next_cursor: tail && start + take < all.length ? `${tail.endedAt.getTime()}.${tail.clientId}` : null,
    };
  }

  /**
   * Ask Roman to write to one churned client, on the coach Home's draft path
   * (draft.coach_message, new reason kind plan_ended). The gateway files a
   * pending draft and sends nothing; the coach sends it with PATCH
   * /ai/gateway/drafts/:id (the normal chat send). Capability, consent, budget
   * and context rules are the gateway's own.
   */
  async draft(caller: Caller, clientId: string, meta: { ip: string | null; userAgent: string | null }, now = new Date()) {
    const [row] = await this.churned(caller.id, now, clientId);
    if (!row) throw notFound();
    const days = (await this.coachWeek(caller.id, now)).daysSince(row.endedAt);
    const request = winBackDraft(row, days);
    const ctx = await this.context.loadClientContext(
      { id: caller.id, role: caller.role, coach_id: caller.coach_id },
      clientId,
      { capability: request.capability },
    );
    const result = await this.gateway.invoke({
      capability: request.capability,
      requester: { id: caller.id, role: caller.role },
      subjectUserId: clientId,
      tenantCoachId: caller.role === 'coach' ? caller.id : undefined,
      userMessage: request.message,
      systemPrompt: ctx.systemPrompt,
      provenance: ctx.provenance,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return {
      reason: { kind: 'plan_ended' as const, days_since: days, package_name: row.packageName },
      request_id: result.requestId,
      approval: { required: result.approvalRequired, status: result.approvalStatus, draft_id: result.approvalDraftId },
      enabled: result.enabled,
      provider: result.provider,
      reply: result.reply,
      draft_mode: result.draftMode,
    };
  }

  /** The coach's day (zone as the coach Home resolves it). */
  private async coachWeek(coachId: string, now: Date) {
    const tz = (await resolveRecipientTimeZone(this.prisma, coachId)) ?? 'America/Los_Angeles';
    const week = clientWeek(now, tz);
    const daysSince = (at: Date) => Math.round((Date.parse(week.today) - Date.parse(week.dayOf(at))) / DAY_MS);
    return { ...week, tz, daysSince };
  }

  /** This coach's churned clients (one row each: their latest ended plan), newest end first; `clientId` narrows to one. */
  private async churned(coachId: string, now: Date, clientId?: string): Promise<Churned[]> {
    const since = new Date(now.getTime() - CHURNED_CLIENTS_WINDOW_DAYS * DAY_MS);
    const purchases = await this.prisma.clientPurchase.findMany({
      where: {
        coach_user_id: coachId,
        client: { coach_id: coachId },
        ...(clientId ? { client_user_id: clientId } : {}),
        ...endedPlanWhere(since, now),
      },
      select: {
        id: true, client_user_id: true, coach_user_id: true, billing_type: true,
        access_expires_at: true, canceled_at: true, current_period_end: true, package: { select: { name: true } },
      },
    });
    const latest = new Map<string, Churned>();
    for (const p of purchases) {
      const endedAt = planEndedAt(p, now);
      if (!endedAt || endedAt <= since || endedAt > now) continue;
      const seen = latest.get(p.client_user_id);
      if (!seen || endedAt > seen.endedAt) latest.set(p.client_user_id, { clientId: p.client_user_id, endedAt, packageName: p.package.name });
    }
    const out: Churned[] = [];
    for (const row of latest.values()) {
      if (!(await planRenewalBlock(this.prisma, row.clientId, coachId, now))) out.push(row);
    }
    return out.sort((a, b) => b.endedAt.getTime() - a.endedAt.getTime() || (a.clientId < b.clientId ? -1 : 1));
  }
}

/** The win-back ask. The package name is coach-typed: fenced, on one line, in quotes. */
function winBackDraft(row: Churned, days: number): HomeWinDraft {
  const pkg = sanitizePromptInput(row.packageName, 60).replace(/\s+/g, ' ').replace(/"/g, "'").trim();
  const when = days === 0 ? 'today' : days === 1 ? '1 day ago' : `${days} days ago`;
  return {
    capability: 'draft.coach_message',
    subject_user_id: row.clientId,
    message:
      `Write a short, warm note to this client, whose plan "${pkg || 'their plan'}" with me ended ${when}. ` +
      'Invite them back to a package or program with me and ask one easy question. Do not mention prices or discounts.',
  };
}
