import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
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
/**
 * B-658-1 — team tenancy, from the same attribution as the legacy create
 * (InviteCodesService.resolveTeamAttribution): an active team sub-coach works
 * in the head coach's tenant and sees or changes only the codes they issued;
 * the head coach sees and manages every team code.
 */
type Scope = { tenantId: string; issuerId: string | null };

export type CodeStatus = 'active' | 'retiring' | 'revoked' | 'expired' | 'used_up';

export type CoachCodeView = {
  id: string;
  kind: 'coach_link' | 'invite_code';
  code: string;
  label: string | null;
  status: CodeStatus;
  /** The team sub-coach who issued the code (null: issued by the coach themselves). */
  issued_by_user_id: string | null;
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
  invited_by_user_id: string | null;
  successor_code: string | null;
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
  successor_code: true,
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
  return row.rotated_to || row.successor_code ? 'retiring' : 'active';
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
    const scope = await this.scopeOf(coachId);
    // A sub-coach has no team coach link: their own profile link would attach
    // clients outside the head coach's tenant (B-658-1).
    const profile = scope.issuerId
      ? null
      : await this.inviteCodes.getOrCreateDefaultForCoach(coachId);
    const rows = await this.prisma.inviteCode.findMany({
      // Shareable codes only: single-recipient (emailed) invites are managed
      // in the invite flow and are bound to one email, so they cannot leak.
      where: { ...rowWhere(scope), intended_email: null },
      orderBy: { created_at: 'desc' },
      take: LIST_LIMIT,
      select: ROW_SELECT,
    });
    const usage = await this.usageByCode(scope);
    const packages = await this.packageNames([
      profile?.invite_code_package_id,
      ...rows.map((r) => r.package_id),
    ]);

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
      codes: [...(profile ? [this.coachLinkView(profile, usage, packages)] : []), ...views],
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
    const raw = typeof idempotencyKey === 'string' ? idempotencyKey.trim() : '';
    const clean = normaliseIdempotencyKey(raw);
    if (raw && !clean) {
      // C-658-5: a malformed key is refused, never ignored (a retry would mint a second code).
      throw new BadRequestException({
        code: 'idempotency_key_invalid',
        message:
          'The Idempotency-Key header must be 8 to 128 visible characters without spaces. Retry with a new key.',
      });
    }
    const scope = await this.scopeOf(actor.id);
    // B-658-9: packages belong to the head coach (as legacy setBinding and
    // NoActiveSubCoachGuard), so a sub-coach never binds one to a code.
    if (scope.issuerId && (input.package_id || input.grant_mode)) {
      throw new ForbiddenException({
        code: 'code_package_head_coach_only',
        message:
          'Packages on codes are set by your head coach. Create this code without a package, or ask your head coach to add one.',
      });
    }
    // Keys are per issuer, so a team member's key never replays another member's code.
    const key = clean ? `${actor.id}:${clean}` : null;
    const replay = async () =>
      key
        ? this.prisma.inviteCode.findUnique({
            where: { coach_id_idempotency_key: { coach_id: scope.tenantId, idempotency_key: key } },
            select: ROW_SELECT,
          })
        : null;
    const prior = await replay();
    if (prior) return { code: await this.viewOne(scope, prior), replayed: true };

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

    // B-658-6: the package is decided BEFORE the code exists and written in
    // the same INSERT, so no replay, list or attach ever sees an active code
    // without its binding. A package archived later is re-checked at grant
    // time (InviteGrantService.grantForAttachedCode), as for any bound code.
    let packageId: string | null = null;
    if (input.package_id && input.grant_mode) {
      try {
        if (!this.grants) throw new Error('grant service unavailable');
        packageId = await this.grants.assertBindablePackage(scope.tenantId, input.package_id);
      } catch (err) {
        throw mapBindingError(err);
      }
    }

    let created: InviteRow | null = null;
    for (let attempt = 0; attempt < 10 && !created; attempt++) {
      const code = await this.inviteCodes.generateCodeUniqueAcrossTables();
      try {
        created = await this.prisma.inviteCode.create({
          data: {
            code,
            coach_id: scope.tenantId,
            invited_by_user_id: scope.issuerId,
            label,
            max_uses: input.max_uses ?? null,
            expires_at: expiresAt,
            idempotency_key: key,
            package_id: packageId,
            grant_mode: packageId && input.grant_mode ? input.grant_mode : 'none',
          },
          select: ROW_SELECT,
        });
      } catch (err) {
        if (key && isUniqueViolation(err, 'idempotency_key')) {
          // An overlapping retry won: its row is already complete.
          const winner = await replay();
          if (winner) return { code: await this.viewOne(scope, winner), replayed: true };
        }
        if (isUniqueViolation(err)) continue;
        throw err;
      }
    }
    if (!created) throw new InternalServerErrorException('Could not generate a unique invite code');

    void this.audit.write({
      action: CodeAuditAction.CREATED,
      actorId: actor.id,
      actorRole: actor.role,
      actorEmail: actor.email ?? null,
      tenantCoachId: scope.tenantId,
      targetType: 'invite_code',
      targetId: created.id,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
      metadata: {
        max_uses: input.max_uses ?? null,
        expires_at: expiresAt?.toISOString() ?? null,
        package_id: packageId,
        grant_mode: created.grant_mode,
      },
    });
    if (scope.issuerId) {
      // Same team feed event as the legacy create (InviteCodesService.createForCoach).
      await this.prisma.teamAuditEvent
        .create({
          data: {
            head_coach_id: scope.tenantId,
            actor_user_id: scope.issuerId,
            target_client_id: null,
            event_kind: 'invite_sent_by_sub_coach',
            summary: 'Invite code issued by sub-coach.',
            metadata: { invite_code_id: created.id, sub_coach_id: scope.issuerId },
          },
        })
        .catch(() => this.logger.warn(`team audit event write failed for invite ${created?.id}`));
    }
    return { code: await this.viewOne(scope, created), replayed: false };
  }

  // -------------------------------------------------------------- rotate

  async rotate(
    actor: CodeActor,
    id: string,
    graceHoursRaw: number | undefined,
    ctx: Ctx = {},
    expectedCode?: string | null,
  ): Promise<{ code: CoachCodeView; previous: CoachCodeView | null; replayed: boolean }> {
    const graceHours = Math.min(
      Math.max(Math.trunc(graceHoursRaw ?? 0), 0),
      ROTATE_GRACE_HOURS_MAX,
    );
    const graceMs = graceHours * 60 * 60 * 1000;
    const scope = await this.scopeOf(actor.id);

    if (id === COACH_LINK_ID) {
      if (scope.issuerId) {
        throw new ForbiddenException({
          code: 'coach_link_head_coach_only',
          message:
            'The team coach link belongs to your head coach. Create your own code here, or ask your head coach to rotate the link.',
        });
      }
      // B-658-7: rotate the link the coach is looking at; a retry of that
      // rotation returns its first successor and changes nothing.
      const expected = typeof expectedCode === 'string' ? expectedCode.trim() : '';
      if (!expected) {
        throw new BadRequestException({
          code: 'expected_code_required',
          message: 'Pull to refresh your codes, then rotate the coach link shown on screen.',
        });
      }
      const { profile, previous, replayed, successorCode } =
        await this.inviteCodes.rotateDefaultCode(actor.id, graceMs, expected);
      if (!replayed)
        this.writeRotateAudit(actor, ctx, actor.id, 'coach_link', previous.id, null, graceHours);
      const [prevRow, nextRow] = await Promise.all([
        this.prisma.inviteCode.findUnique({ where: { id: previous.id }, select: ROW_SELECT }),
        successorCode === profile.invite_code
          ? null
          : this.prisma.inviteCode.findUnique({
              where: { code: successorCode },
              select: ROW_SELECT,
            }),
      ]);
      const usage = await this.usageByCode(scope);
      const packages = await this.packageNames([
        profile.invite_code_package_id,
        prevRow?.package_id,
        nextRow?.package_id,
      ]);
      const now = Date.now();
      return {
        code: nextRow
          ? this.rowView(nextRow, usage, packages, now)
          : this.coachLinkView(profile, usage, packages),
        previous: prevRow ? this.rowView(prevRow, usage, packages, now) : null,
        replayed,
      };
    }

    const old = await this.prisma.inviteCode.findUnique({ where: { id }, select: ROW_SELECT });
    if (!old || !owns(scope, old)) throw codeNotFound();
    if (old.rotated_to) {
      // Retried rotate: the successor already exists. Return it, never mint a second.
      const successor = await this.prisma.inviteCode.findUnique({
        where: { id: old.rotated_to.id },
        select: ROW_SELECT,
      });
      if (successor) {
        return {
          code: await this.viewOne(scope, successor),
          previous: await this.viewOne(scope, old),
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
              coach_id: old.coach_id,
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
            where: { id: old.id, coach_id: old.coach_id, revoked: false },
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
              code: await this.viewOne(scope, winner),
              previous: prev ? await this.viewOne(scope, prev) : null,
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

    this.writeRotateAudit(actor, ctx, old.coach_id, 'invite_code', old.id, successorId, graceHours);
    const [next, prev] = await Promise.all([
      this.prisma.inviteCode.findUnique({ where: { id: successorId }, select: ROW_SELECT }),
      this.prisma.inviteCode.findUnique({ where: { id: old.id }, select: ROW_SELECT }),
    ]);
    if (!next) throw codeNotFound();
    return {
      code: await this.viewOne(scope, next),
      previous: prev ? await this.viewOne(scope, prev) : null,
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
    const scope = await this.scopeOf(actor.id);
    const row = await this.prisma.inviteCode.findUnique({ where: { id }, select: ROW_SELECT });
    if (!row || !owns(scope, row)) throw codeNotFound();
    if (row.revoked) return { code: await this.viewOne(scope, row), replayed: true };

    const now = new Date();
    await this.prisma.inviteCode.updateMany({
      where: { id, coach_id: row.coach_id, revoked: false },
      data: { revoked: true, revoked_at: now },
    });
    void this.audit.write({
      action: CodeAuditAction.REVOKED,
      actorId: actor.id,
      actorRole: actor.role,
      actorEmail: actor.email ?? null,
      tenantCoachId: row.coach_id,
      targetType: 'invite_code',
      targetId: id,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
      metadata: { used_count: row.used_count },
    });
    const fresh = await this.prisma.inviteCode.findUnique({ where: { id }, select: ROW_SELECT });
    return {
      code: await this.viewOne(scope, fresh ?? { ...row, revoked: true, revoked_at: now }),
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
    const scope = await this.scopeOf(coachId);
    const profile = await this.prisma.coachProfile.findUnique({
      where: { user_id: coachId },
      select: { timezone: true, invite_code: true },
    });
    const linkCode = scope.issuerId ? null : (profile?.invite_code ?? null);
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
        ...ledgerWhere(scope),
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
      where: { ...rowWhere(scope), intended_email: null, revoked: false },
      select: { id: true, code: true, label: true },
      take: LIST_LIMIT,
    });
    const labels = new Map<string, { id: string; label: string | null }>(
      live.map((r) => [r.code, { id: r.id, label: r.label }]),
    );
    const missing = [...byCode.keys()].filter((c) => !labels.has(c) && c !== linkCode);
    if (missing.length) {
      const extra = await this.prisma.inviteCode.findMany({
        where: { ...rowWhere(scope), code: { in: missing } },
        select: { id: true, code: true, label: true },
      });
      for (const r of extra) labels.set(r.code, { id: r.id, label: r.label });
    }
    const codeKeys = new Set<string>([...byCode.keys(), ...live.map((r) => r.code)]);
    if (linkCode) codeKeys.add(linkCode);

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
          const isLink = code === linkCode;
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
    tenantId: string,
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
      tenantCoachId: tenantId,
      targetType: kind === 'coach_link' ? 'coach_profile_invite_code' : 'invite_code',
      targetId: successorId ?? actor.id,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
      metadata: { code_kind: kind, previous_invite_code_id: previousId, grace_hours: graceHours },
    });
  }

  private async scopeOf(actorId: string): Promise<Scope> {
    const a = await this.inviteCodes.resolveTeamAttribution(actorId);
    return { tenantId: a.effective_coach_id, issuerId: a.invited_by_user_id };
  }

  private async usageByCode(scope: Scope): Promise<Map<string, { total: number; week: number }>> {
    const since = new Date(Date.now() - 7 * DAY_MS);
    const [all, week] = await Promise.all([
      this.prisma.inviteRedemption.groupBy({
        by: ['code'],
        where: ledgerWhere(scope),
        _count: { _all: true },
      }),
      this.prisma.inviteRedemption.groupBy({
        by: ['code'],
        where: { ...ledgerWhere(scope), redeemed_at: { gte: since } },
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

  private async viewOne(scope: Scope, row: InviteRow): Promise<CoachCodeView> {
    const usage = await this.usageByCode(scope);
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
      issued_by_user_id: null,
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
      issued_by_user_id: row.invited_by_user_id,
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

function rowWhere(s: Scope): Prisma.InviteCodeWhereInput {
  return { coach_id: s.tenantId, ...(s.issuerId ? { invited_by_user_id: s.issuerId } : {}) };
}

function ledgerWhere(s: Scope): Prisma.InviteRedemptionWhereInput {
  return {
    coach_id: s.tenantId,
    ...(s.issuerId ? { invite_code: { is: { invited_by_user_id: s.issuerId } } } : {}),
  };
}

/** The caller may see and change this shareable code (B-658-1); anything else is a non-leaking 404. */
function owns(
  s: Scope,
  row: { coach_id: string; invited_by_user_id: string | null; intended_email: string | null },
): boolean {
  if (row.coach_id !== s.tenantId || row.intended_email) return false;
  return !s.issuerId || row.invited_by_user_id === s.issuerId;
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
