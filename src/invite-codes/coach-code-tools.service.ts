import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Prisma, type InviteGrantMode } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../audit/audit.service';
import { InviteGrantService } from '../invite-grant/invite-grant.service';
import { InviteCodesService, inviteCodeRowLifecycle } from './invite-codes.service';
import { CODE_LABEL_MAX, ROTATE_GRACE_HOURS_MAX, SIGNUP_DAYS_MAX } from './coach-code-tools.dto';

/**
 * A2 coach code tools: create / rotate / revoke shareable codes, list them
 * with usage, QR payloads, and exact daily signups per code and package in
 * the coach's time zone. Tenancy: every read and write is scoped to the
 * caller's own user id (the controller never takes a coach id); a code that
 * belongs to another coach is a non-leaking 404.
 */

export const COACH_LINK_ID = 'coach-link' as const;
export const DEFAULT_COACH_TIMEZONE = 'America/Los_Angeles';
const DEFAULT_JOIN_BASE = 'https://app.trygrowthproject.com/join';
const LIST_LIMIT = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

export const CodeAuditAction = {
  CREATED: 'invite_code.created',
  ROTATED: 'invite_code.rotated',
  REVOKED: 'invite_code.revoked',
} as const;

export type CodeActor = { id: string; role: string; email?: string | null };
type Ctx = { ip?: string | null; userAgent?: string | null };

export type CodeStatus = 'active' | 'retiring' | 'revoked' | 'expired' | 'used_up';

export type CoachCodeView = {
  id: string;
  kind: 'coach_link' | 'invite_code';
  code: string;
  label: string | null;
  status: CodeStatus;
  join_url: string;
  /** What the QR encodes: the universal link, which opens the app on /join/<code>. */
  qr_payload: string;
  created_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  max_uses: number | null;
  used_count: number | null;
  signups_total: number;
  signups_7d: number;
  package: { id: string; name: string } | null;
  grant_mode: InviteGrantMode;
  rotated_from: { id: string; code: string } | null;
  rotated_to: { id: string; code: string } | null;
};

type InviteRow = {
  id: string;
  code: string;
  label: string | null;
  created_at: Date;
  expires_at: Date | null;
  revoked: boolean;
  revoked_at: Date | null;
  max_uses: number | null;
  used_count: number;
  package_id: string | null;
  grant_mode: InviteGrantMode;
  rotated_from: { id: string; code: string } | null;
  rotated_to: { id: string; code: string } | null;
};

const ROW_SELECT = {
  id: true,
  code: true,
  label: true,
  created_at: true,
  expires_at: true,
  revoked: true,
  revoked_at: true,
  max_uses: true,
  used_count: true,
  package_id: true,
  grant_mode: true,
  intended_email: true,
  coach_id: true,
  invited_by_user_id: true,
  rotated_from: { select: { id: true, code: true } },
  rotated_to: { select: { id: true, code: true } },
} as const;

export function joinUrlFor(code: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = (env.PUBLIC_INVITE_BASE_URL || DEFAULT_JOIN_BASE).trim().replace(/\/+$/, '');
  return `${base}/${encodeURIComponent(code)}`;
}

/** True when `tz` is an IANA zone this runtime can format in. */
export function isValidTimeZone(tz: string | null | undefined): tz is string {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Calendar date (YYYY-MM-DD) of `at` in time zone `tz`. DST-safe (Intl). */
export function localDate(at: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** The `days` calendar dates ending at `endDate` (inclusive), oldest first. */
export function dateRange(endDate: string, days: number): string[] {
  const [y, m, d] = endDate.split('-').map(Number);
  const end = Date.UTC(y, m - 1, d);
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--)
    out.push(new Date(end - i * DAY_MS).toISOString().slice(0, 10));
  return out;
}

export function codeStatus(row: InviteRow, now: number = Date.now()): CodeStatus {
  const lifecycle = inviteCodeRowLifecycle(row, now);
  if (lifecycle === 'revoked') return 'revoked';
  if (lifecycle === 'expired') return 'expired';
  if (lifecycle === 'max_uses_reached') return 'used_up';
  return row.rotated_to ? 'retiring' : 'active';
}

/**
 * Leak signal for the coach ("did my clinic code get posted somewhere?"):
 * today has at least 3 signups AND at least 3x the trailing 7-day daily
 * average (days before today). Deliberately simple and explainable.
 */
export function isUnusualToday(series: number[]): boolean {
  if (series.length === 0) return false;
  const today = series[series.length - 1];
  const prior = series.slice(-8, -1);
  const avg = prior.length ? prior.reduce((a, b) => a + b, 0) / prior.length : 0;
  return today >= 3 && today >= 3 * Math.max(avg, 1);
}

function codeNotFound(): NotFoundException {
  return new NotFoundException({
    code: 'code_not_found',
    message: 'This code is not on your account. Pull to refresh your codes and try again.',
  });
}

@Injectable()
export class CoachCodeToolsService {
  private readonly logger = new Logger(CoachCodeToolsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly inviteCodes: InviteCodesService,
    private readonly audit: AuditService,
    @Optional() private readonly grants?: InviteGrantService,
  ) {}

  // ---------------------------------------------------------------- list

  async list(coachId: string): Promise<{ codes: CoachCodeView[]; tracking_note: string }> {
    const profile = await this.inviteCodes.getOrCreateDefaultForCoach(coachId);
    const rows = await this.prisma.inviteCode.findMany({
      // Shareable codes only: single-recipient (emailed) invites are managed
      // in the invite flow and are bound to one email, so they cannot leak.
      where: { coach_id: coachId, intended_email: null },
      orderBy: { created_at: 'desc' },
      take: LIST_LIMIT,
      select: ROW_SELECT,
    });
    const usage = await this.usageByCode(coachId);
    const packages = await this.packageNames([
      profile.invite_code_package_id,
      ...rows.map((r) => r.package_id),
    ]);

    const link = this.coachLinkView(profile, usage, packages);
    const now = Date.now();
    const views = rows.map((r) => this.rowView(r, usage, packages, now));
    const rank: Record<CodeStatus, number> = {
      active: 0,
      retiring: 1,
      used_up: 2,
      expired: 3,
      revoked: 4,
    };
    views.sort((a, b) => rank[a.status] - rank[b.status]);
    return {
      codes: [link, ...views],
      tracking_note:
        'Signup counts include every signup since code tools were added to your account.',
    };
  }

  // -------------------------------------------------------------- create

  async create(
    actor: CodeActor,
    input: {
      label?: string;
      max_uses?: number | null;
      expires_at?: string | null;
      package_id?: string;
      grant_mode?: Exclude<InviteGrantMode, 'none'>;
    },
    idempotencyKey: string | null,
    ctx: Ctx = {},
  ): Promise<{ code: CoachCodeView; replayed: boolean }> {
    const key = normaliseIdempotencyKey(idempotencyKey);
    if (key) {
      const prior = await this.prisma.inviteCode.findUnique({
        where: { coach_id_idempotency_key: { coach_id: actor.id, idempotency_key: key } },
        select: ROW_SELECT,
      });
      if (prior) return { code: await this.viewOne(actor.id, prior), replayed: true };
    }

    const label = cleanLabel(input.label);
    const expiresAt = input.expires_at ? new Date(input.expires_at) : null;
    if (expiresAt && (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now())) {
      throw new BadRequestException({
        code: 'expiry_in_past',
        message: 'Pick an end date in the future, or leave the code without an end date.',
      });
    }
    if (input.package_id && !input.grant_mode) {
      throw new BadRequestException({
        code: 'grant_mode_required',
        message:
          'Choose whether the package is free or prepaid for people who join with this code.',
      });
    }
    if (input.grant_mode && !input.package_id) {
      throw new BadRequestException({
        code: 'package_required',
        message: 'Pick the package people get when they join with this code.',
      });
    }

    let created: { id: string; code: string } | null = null;
    for (let attempt = 0; attempt < 10 && !created; attempt++) {
      const code = await this.inviteCodes.generateCodeUniqueAcrossTables();
      try {
        created = await this.prisma.inviteCode.create({
          data: {
            code,
            coach_id: actor.id,
            label,
            max_uses: input.max_uses ?? null,
            expires_at: expiresAt,
            idempotency_key: key,
          },
          select: { id: true, code: true },
        });
      } catch (err) {
        if (isUniqueViolation(err, 'idempotency_key') && key) {
          const prior = await this.prisma.inviteCode.findUnique({
            where: { coach_id_idempotency_key: { coach_id: actor.id, idempotency_key: key } },
            select: ROW_SELECT,
          });
          if (prior) return { code: await this.viewOne(actor.id, prior), replayed: true };
        }
        if (isUniqueViolation(err)) continue;
        throw err;
      }
    }
    if (!created) throw new InternalServerErrorException('Could not generate a unique invite code');

    if (input.package_id && input.grant_mode) {
      try {
        if (!this.grants) throw new Error('grant service unavailable');
        await this.grants.setBinding(
          actor,
          { code: created.code, package_id: input.package_id, grant_mode: input.grant_mode },
          ctx,
        );
      } catch (err) {
        // The code was never returned to anyone, so removing it is safe and
        // leaves no half-made code behind.
        try {
          await this.prisma.inviteCode.delete({ where: { id: created.id } });
        } catch (cleanupErr) {
          // Unreachable in practice (fresh row, no redemptions). Log it so a
          // stray unbound code is visible; the coach still gets the real reason.
          this.logger.warn(
            `could not remove unbound code ${created.id} after a refused binding: ${
              cleanupErr instanceof Error ? cleanupErr.message : 'unknown'
            }`,
          );
        }
        throw mapBindingError(err);
      }
    }

    void this.audit.write({
      action: CodeAuditAction.CREATED,
      actorId: actor.id,
      actorRole: actor.role,
      actorEmail: actor.email ?? null,
      tenantCoachId: actor.id,
      targetType: 'invite_code',
      targetId: created.id,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
      metadata: {
        max_uses: input.max_uses ?? null,
        expires_at: expiresAt?.toISOString() ?? null,
        package_id: input.package_id ?? null,
        grant_mode: input.grant_mode ?? 'none',
      },
    });
    const row = await this.prisma.inviteCode.findUnique({
      where: { id: created.id },
      select: ROW_SELECT,
    });
    if (!row) throw codeNotFound();
    return { code: await this.viewOne(actor.id, row), replayed: false };
  }

  // -------------------------------------------------------------- rotate

  async rotate(
    actor: CodeActor,
    id: string,
    graceHoursRaw: number | undefined,
    ctx: Ctx = {},
  ): Promise<{ code: CoachCodeView; previous: CoachCodeView | null; replayed: boolean }> {
    const graceHours = Math.min(
      Math.max(Math.trunc(graceHoursRaw ?? 0), 0),
      ROTATE_GRACE_HOURS_MAX,
    );
    const graceMs = graceHours * 60 * 60 * 1000;

    if (id === COACH_LINK_ID) {
      const { profile, previous } = await this.inviteCodes.rotateDefaultCode(actor.id, graceMs);
      this.writeRotateAudit(actor, ctx, 'coach_link', previous.id, null, graceHours);
      const prevRow = await this.prisma.inviteCode.findUnique({
        where: { id: previous.id },
        select: ROW_SELECT,
      });
      const usage = await this.usageByCode(actor.id);
      const packages = await this.packageNames([
        profile.invite_code_package_id,
        prevRow?.package_id ?? null,
      ]);
      return {
        code: this.coachLinkView(profile, usage, packages),
        previous: prevRow ? this.rowView(prevRow, usage, packages, Date.now()) : null,
        replayed: false,
      };
    }

    const old = await this.prisma.inviteCode.findUnique({ where: { id }, select: ROW_SELECT });
    if (!old || old.coach_id !== actor.id || old.intended_email) throw codeNotFound();
    if (old.rotated_to) {
      // Retried rotate: the successor already exists. Return it, never mint a second.
      const successor = await this.prisma.inviteCode.findUnique({
        where: { id: old.rotated_to.id },
        select: ROW_SELECT,
      });
      if (successor) {
        return {
          code: await this.viewOne(actor.id, successor),
          previous: await this.viewOne(actor.id, old),
          replayed: true,
        };
      }
    }
    if (old.revoked) {
      throw new ConflictException({
        code: 'code_already_revoked',
        message:
          'This code is already turned off, so there is nothing to replace. Create a new code instead.',
      });
    }

    const now = Date.now();
    const keepExpiry = old.expires_at && old.expires_at.getTime() > now ? old.expires_at : null;
    let successorId: string | null = null;
    for (let attempt = 0; attempt < 10 && !successorId; attempt++) {
      const code = await this.inviteCodes.generateCodeUniqueAcrossTables();
      try {
        successorId = await this.prisma.$transaction(async (tx) => {
          const successor = await tx.inviteCode.create({
            data: {
              code,
              coach_id: actor.id,
              invited_by_user_id: old.invited_by_user_id,
              label: old.label,
              max_uses: old.max_uses,
              expires_at: keepExpiry,
              package_id: old.package_id,
              grant_mode: old.grant_mode,
              rotated_from_id: old.id,
            },
            select: { id: true },
          });
          const graceEnd = new Date(now + graceMs);
          const retired = await tx.inviteCode.updateMany({
            where: { id: old.id, coach_id: actor.id, revoked: false },
            data:
              graceMs > 0
                ? {
                    expires_at:
                      old.expires_at && old.expires_at < graceEnd ? old.expires_at : graceEnd,
                  }
                : { revoked: true, revoked_at: new Date(now) },
          });
          if (retired.count !== 1) {
            throw new ConflictException({
              code: 'code_already_revoked',
              message: 'This code was turned off on another device. Pull to refresh your codes.',
            });
          }
          return successor.id;
        });
      } catch (err) {
        if (isUniqueViolation(err, 'rotated_from_id')) {
          // A concurrent rotate won: return its successor (idempotent).
          const winner = await this.prisma.inviteCode.findUnique({
            where: { rotated_from_id: old.id },
            select: ROW_SELECT,
          });
          if (winner) {
            const prev = await this.prisma.inviteCode.findUnique({
              where: { id: old.id },
              select: ROW_SELECT,
            });
            return {
              code: await this.viewOne(actor.id, winner),
              previous: prev ? await this.viewOne(actor.id, prev) : null,
              replayed: true,
            };
          }
        }
        if (isUniqueViolation(err)) continue;
        throw err;
      }
    }
    if (!successorId)
      throw new InternalServerErrorException('Could not generate a unique invite code');

    this.writeRotateAudit(actor, ctx, 'invite_code', old.id, successorId, graceHours);
    const [next, prev] = await Promise.all([
      this.prisma.inviteCode.findUnique({ where: { id: successorId }, select: ROW_SELECT }),
      this.prisma.inviteCode.findUnique({ where: { id: old.id }, select: ROW_SELECT }),
    ]);
    if (!next) throw codeNotFound();
    return {
      code: await this.viewOne(actor.id, next),
      previous: prev ? await this.viewOne(actor.id, prev) : null,
      replayed: false,
    };
  }

  // -------------------------------------------------------------- revoke

  async revoke(
    actor: CodeActor,
    id: string,
    ctx: Ctx = {},
  ): Promise<{ code: CoachCodeView; replayed: boolean }> {
    if (id === COACH_LINK_ID) {
      throw new ConflictException({
        code: 'coach_link_not_revocable',
        message:
          'Your coach link cannot be turned off, only replaced. Rotate it to retire the current one.',
      });
    }
    const row = await this.prisma.inviteCode.findUnique({ where: { id }, select: ROW_SELECT });
    if (!row || row.coach_id !== actor.id || row.intended_email) throw codeNotFound();
    if (row.revoked) return { code: await this.viewOne(actor.id, row), replayed: true };

    const now = new Date();
    await this.prisma.inviteCode.updateMany({
      where: { id, coach_id: actor.id, revoked: false },
      data: { revoked: true, revoked_at: now },
    });
    void this.audit.write({
      action: CodeAuditAction.REVOKED,
      actorId: actor.id,
      actorRole: actor.role,
      actorEmail: actor.email ?? null,
      tenantCoachId: actor.id,
      targetType: 'invite_code',
      targetId: id,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
      metadata: { used_count: row.used_count },
    });
    const fresh = await this.prisma.inviteCode.findUnique({ where: { id }, select: ROW_SELECT });
    return {
      code: await this.viewOne(actor.id, fresh ?? { ...row, revoked: true, revoked_at: now }),
      replayed: false,
    };
  }

  // ------------------------------------------------------------- signups

  /**
   * Exact daily signups (InviteRedemption rows) for the last `days` calendar
   * days in the coach's time zone, overall, per code and per package. Days
   * with no signups are present with 0, so the chart never skips a day.
   */
  async signups(coachId: string, daysRaw: number | undefined, now: Date = new Date()) {
    const days = Math.min(Math.max(Math.trunc(daysRaw ?? 30), 1), SIGNUP_DAYS_MAX);
    const profile = await this.prisma.coachProfile.findUnique({
      where: { user_id: coachId },
      select: { timezone: true, invite_code: true },
    });
    const tz = isValidTimeZone(profile?.timezone)
      ? (profile?.timezone as string)
      : DEFAULT_COACH_TIMEZONE;
    const today = localDate(now, tz);
    const dates = dateRange(today, days);
    const first = dates[0];

    // Superset window in UTC (a local day is at most 26h wide), then exact
    // bucketing by local calendar date.
    const rows = await this.prisma.inviteRedemption.findMany({
      where: {
        coach_id: coachId,
        redeemed_at: { gte: new Date(now.getTime() - (days + 2) * DAY_MS), lte: now },
      },
      select: { code: true, package_id: true, redeemed_at: true, invite_code_id: true },
    });

    const index = new Map(dates.map((d, i) => [d, i] as const));
    const total = new Array<number>(days).fill(0);
    const byCode = new Map<string, { invite_code_id: string | null; counts: number[] }>();
    const byPackage = new Map<string, number[]>();
    for (const r of rows) {
      const i = index.get(localDate(r.redeemed_at, tz));
      if (i === undefined || r.redeemed_at.getTime() > now.getTime()) continue;
      total[i] += 1;
      const c = byCode.get(r.code) ?? {
        invite_code_id: r.invite_code_id,
        counts: new Array<number>(days).fill(0),
      };
      c.counts[i] += 1;
      byCode.set(r.code, c);
      const pk = r.package_id ?? '';
      const p = byPackage.get(pk) ?? new Array<number>(days).fill(0);
      p[i] += 1;
      byPackage.set(pk, p);
    }

    // Every current shareable code appears, even with zero signups.
    const live = await this.prisma.inviteCode.findMany({
      where: { coach_id: coachId, intended_email: null, revoked: false },
      select: { id: true, code: true, label: true },
      take: LIST_LIMIT,
    });
    const labels = new Map<string, { id: string; label: string | null }>(
      live.map((r) => [r.code, { id: r.id, label: r.label }]),
    );
    const missing = [...byCode.keys()].filter((c) => !labels.has(c) && c !== profile?.invite_code);
    if (missing.length) {
      const extra = await this.prisma.inviteCode.findMany({
        where: { coach_id: coachId, code: { in: missing } },
        select: { id: true, code: true, label: true },
      });
      for (const r of extra) labels.set(r.code, { id: r.id, label: r.label });
    }
    const codeKeys = new Set<string>([...byCode.keys(), ...live.map((r) => r.code)]);
    if (profile?.invite_code) codeKeys.add(profile.invite_code);

    const series = (counts: number[]) => dates.map((date, i) => ({ date, count: counts[i] }));
    const sum = (counts: number[]) => counts.reduce((a, b) => a + b, 0);
    const zero = () => new Array<number>(days).fill(0);

    const packageNames = await this.packageNames([...byPackage.keys()].filter(Boolean));
    return {
      timezone: tz,
      timezone_source: tz === profile?.timezone ? 'profile' : 'default',
      from: first,
      to: today,
      total: sum(total),
      today: total[days - 1],
      days: series(total),
      by_code: [...codeKeys]
        .map((code) => {
          const counts = byCode.get(code)?.counts ?? zero();
          const isLink = code === profile?.invite_code;
          const meta = labels.get(code);
          return {
            code,
            id: isLink ? COACH_LINK_ID : (meta?.id ?? byCode.get(code)?.invite_code_id ?? null),
            kind: isLink ? ('coach_link' as const) : ('invite_code' as const),
            label: isLink ? 'Coach link' : (meta?.label ?? null),
            total: sum(counts),
            today: counts[days - 1],
            unusual_today: isUnusualToday(counts),
            days: series(counts),
          };
        })
        .sort((a, b) => b.total - a.total || a.code.localeCompare(b.code)),
      by_package: [...byPackage.entries()]
        .map(([pk, counts]) => ({
          package_id: pk || null,
          package_name: pk ? (packageNames.get(pk) ?? 'Package no longer available') : null,
          total: sum(counts),
          days: series(counts),
        }))
        .sort((a, b) => b.total - a.total),
    };
  }

  // ------------------------------------------------------------- helpers

  private writeRotateAudit(
    actor: CodeActor,
    ctx: Ctx,
    kind: 'coach_link' | 'invite_code',
    previousId: string,
    successorId: string | null,
    graceHours: number,
  ): void {
    void this.audit.write({
      action: CodeAuditAction.ROTATED,
      actorId: actor.id,
      actorRole: actor.role,
      actorEmail: actor.email ?? null,
      tenantCoachId: actor.id,
      targetType: kind === 'coach_link' ? 'coach_profile_invite_code' : 'invite_code',
      targetId: successorId ?? actor.id,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
      metadata: { code_kind: kind, previous_invite_code_id: previousId, grace_hours: graceHours },
    });
  }

  private async usageByCode(
    coachId: string,
  ): Promise<Map<string, { total: number; week: number }>> {
    const since = new Date(Date.now() - 7 * DAY_MS);
    const [all, week] = await Promise.all([
      this.prisma.inviteRedemption.groupBy({
        by: ['code'],
        where: { coach_id: coachId },
        _count: { _all: true },
      }),
      this.prisma.inviteRedemption.groupBy({
        by: ['code'],
        where: { coach_id: coachId, redeemed_at: { gte: since } },
        _count: { _all: true },
      }),
    ]);
    const out = new Map<string, { total: number; week: number }>();
    for (const g of all) out.set(g.code, { total: g._count._all, week: 0 });
    for (const g of week)
      out.set(g.code, { total: out.get(g.code)?.total ?? g._count._all, week: g._count._all });
    return out;
  }

  private async packageNames(ids: Array<string | null | undefined>): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((v): v is string => !!v))];
    if (!unique.length) return new Map();
    const rows = await this.prisma.coachPackage.findMany({
      where: { id: { in: unique } },
      select: { id: true, name: true },
    });
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  private async viewOne(coachId: string, row: InviteRow): Promise<CoachCodeView> {
    const usage = await this.usageByCode(coachId);
    const packages = await this.packageNames([row.package_id]);
    return this.rowView(row, usage, packages, Date.now());
  }

  private coachLinkView(
    profile: {
      invite_code: string;
      invite_code_package_id: string | null;
      invite_code_grant_mode: InviteGrantMode;
      created_at?: Date | null;
    },
    usage: Map<string, { total: number; week: number }>,
    packages: Map<string, string>,
  ): CoachCodeView {
    const url = joinUrlFor(profile.invite_code);
    const pk = profile.invite_code_package_id;
    return {
      id: COACH_LINK_ID,
      kind: 'coach_link',
      code: profile.invite_code,
      label: 'Coach link',
      status: 'active',
      join_url: url,
      qr_payload: url,
      created_at: profile.created_at ? profile.created_at.toISOString() : null,
      expires_at: null,
      revoked_at: null,
      max_uses: null,
      used_count: null,
      signups_total: usage.get(profile.invite_code)?.total ?? 0,
      signups_7d: usage.get(profile.invite_code)?.week ?? 0,
      package: pk ? { id: pk, name: packages.get(pk) ?? 'Package no longer available' } : null,
      grant_mode: profile.invite_code_grant_mode,
      rotated_from: null,
      rotated_to: null,
    };
  }

  private rowView(
    row: InviteRow,
    usage: Map<string, { total: number; week: number }>,
    packages: Map<string, string>,
    now: number,
  ): CoachCodeView {
    const url = joinUrlFor(row.code);
    return {
      id: row.id,
      kind: 'invite_code',
      code: row.code,
      label: row.label,
      status: codeStatus(row, now),
      join_url: url,
      qr_payload: url,
      created_at: row.created_at.toISOString(),
      expires_at: row.expires_at?.toISOString() ?? null,
      revoked_at: row.revoked_at?.toISOString() ?? null,
      max_uses: row.max_uses,
      used_count: row.used_count,
      signups_total: usage.get(row.code)?.total ?? 0,
      signups_7d: usage.get(row.code)?.week ?? 0,
      package: row.package_id
        ? {
            id: row.package_id,
            name: packages.get(row.package_id) ?? 'Package no longer available',
          }
        : null,
      grant_mode: row.grant_mode,
      rotated_from: row.rotated_from,
      rotated_to: row.rotated_to,
    };
  }
}

function cleanLabel(raw: string | undefined): string | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.replace(/\s+/g, ' ').trim();
  if (!trimmed) return null;
  if (trimmed.length > CODE_LABEL_MAX) {
    throw new BadRequestException({
      code: 'label_too_long',
      message: `Keep the code name to ${CODE_LABEL_MAX} characters or fewer.`,
    });
  }
  return trimmed;
}

/** Idempotency-Key header: 8-128 visible ASCII chars, else ignored (no replay). */
export function normaliseIdempotencyKey(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  return /^[\x21-\x7e]{8,128}$/.test(v) ? v : null;
}

function isUniqueViolation(err: unknown, field?: string): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false;
  if (!field) return true;
  const target = (err.meta as { target?: unknown } | undefined)?.target;
  const text = Array.isArray(target) ? target.join(',') : String(target ?? '');
  return text.includes(field);
}

/** Map InviteGrantService binding refusals onto this surface's stable codes. */
function mapBindingError(err: unknown): HttpException {
  if (err instanceof HttpException) {
    const body = err.getResponse();
    const tag = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined;
    if (tag === 'PACKAGE_REQUIRES_CONTRACT') {
      return new BadRequestException({
        code: 'package_requires_agreement',
        message:
          'This package needs a signed agreement, so it cannot be attached to a code. Pick another package, or create the code without one.',
      });
    }
    if (tag === 'PACKAGE_NOT_FOUND') {
      return new NotFoundException({
        code: 'package_not_found',
        message:
          'That package is not available. Pick one of your active packages, or create the code without one.',
      });
    }
  }
  return new InternalServerErrorException({
    code: 'code_package_binding_failed',
    message:
      'The code was not created because its package could not be attached. Try again in a moment.',
  });
}
