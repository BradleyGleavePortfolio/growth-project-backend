import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../audit/audit.service';

// Canonical consent scopes. Strings are stored as-is in
// ClientCoachConsent.scope (not a SQL enum) so adding a scope is a code
// change, not a migration. The string form is the wire/contract format
// the mobile app and admin console see.
export const ConsentScope = {
  // Fitness scopes (this backend's first-party domain).
  FITNESS_PROFILE: 'fitness.profile',
  FITNESS_BODY_METRICS: 'fitness.body_metrics',
  FITNESS_WORKOUTS: 'fitness.workouts',
  FITNESS_FOOD_MACROS: 'fitness.food_macros',
  FITNESS_HABITS_PROGRESS: 'fitness.habits_progress',
  // Finance scopes (federated; the rows live here so the client only has
  // one consent surface, the finance backend reads them via federation).
  FINANCE_SUMMARY: 'finance.summary',
  FINANCE_BALANCES: 'finance.balances',
  FINANCE_TRANSACTION_CATEGORIES: 'finance.transaction_categories',
  FINANCE_TRANSACTION_LINE_ITEMS: 'finance.transaction_line_items',
  FINANCE_REPORTS: 'finance.reports',
} as const;

export type ConsentScopeValue = (typeof ConsentScope)[keyof typeof ConsentScope];

const ALL_SCOPES: ConsentScopeValue[] = Object.values(ConsentScope);
const SCOPE_SET: Set<string> = new Set(ALL_SCOPES);

// Audit action strings for consent state transitions. Kept here (not in
// audit.service.ts) so the consent vocabulary stays co-located with the
// service that emits it.
export const ConsentAuditAction = {
  GRANTED: 'consent.granted',
  REVOKED: 'consent.revoked',
} as const;

export interface ConsentRow {
  scope: ConsentScopeValue | string;
  granted: boolean;
  granted_at: Date | null;
  revoked_at: Date | null;
  updated_at: Date;
}

interface AuditContext {
  ip?: string | null;
  userAgent?: string | null;
}

// ConsentService is the single source of truth for client→coach data
// access. Reads (`isGranted`, `coachCanAccess`) are cheap point lookups
// and can be called from coach-side query paths; writes (`grant`,
// `revoke`) emit audit rows.
@Injectable()
export class ConsentService {
  private readonly logger = new Logger(ConsentService.name);

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  static isKnownScope(scope: string): scope is ConsentScopeValue {
    return SCOPE_SET.has(scope);
  }

  static listScopes(): ConsentScopeValue[] {
    return [...ALL_SCOPES];
  }

  // Pure helper used both by the service (after a row read) and by
  // callers that already have a row in hand. The "no row" case is also
  // "not granted" — silence is not consent.
  static rowIsGranted(row: { granted_at: Date | null; revoked_at: Date | null } | null): boolean {
    if (!row) return false;
    if (!row.granted_at) return false;
    if (!row.revoked_at) return true;
    return row.revoked_at.getTime() < row.granted_at.getTime();
  }

  private toRow(row: {
    scope: string;
    granted_at: Date | null;
    revoked_at: Date | null;
    updated_at: Date;
  }): ConsentRow {
    return {
      scope: row.scope,
      granted: ConsentService.rowIsGranted(row),
      granted_at: row.granted_at,
      revoked_at: row.revoked_at,
      updated_at: row.updated_at,
    };
  }

  // Returns one row per known scope for the (client, coach) pair, with
  // unset scopes filled in as `granted: false`. Always returns the full
  // surface so the client UI can render every toggle without a second
  // call to learn which scopes exist.
  async listForClient(clientId: string, coachId: string): Promise<ConsentRow[]> {
    const rows = await this.prisma.clientCoachConsent.findMany({
      where: { client_id: clientId, coach_id: coachId },
    });
    const byScope = new Map<string, (typeof rows)[number]>();
    for (const r of rows) byScope.set(r.scope, r);
    return ALL_SCOPES.map((scope) => {
      const r = byScope.get(scope);
      if (!r) {
        return {
          scope,
          granted: false,
          granted_at: null,
          revoked_at: null,
          updated_at: new Date(0),
        };
      }
      return this.toRow(r);
    });
  }

  async grant(
    clientId: string,
    coachId: string,
    scope: string,
    ctx: AuditContext = {},
  ): Promise<ConsentRow> {
    if (!ConsentService.isKnownScope(scope)) {
      throw new BadRequestException(`Unknown consent scope: ${scope}`);
    }
    // Verify the coach exists and has the coach role. Refuse to grant
    // consent to a non-coach (e.g. a typo in the coach id) since the
    // row would be unreachable anyway.
    const coach = await this.prisma.user.findUnique({ where: { id: coachId } });
    if (!coach) throw new NotFoundException('Coach not found');
    if (coach.role !== 'coach' && coach.role !== 'owner') {
      throw new BadRequestException('Target user is not a coach');
    }

    const now = new Date();
    const existing = await this.prisma.clientCoachConsent.findUnique({
      where: {
        ClientCoachConsent_client_coach_scope_key: {
          client_id: clientId,
          coach_id: coachId,
          scope,
        },
      },
    });

    // Idempotent: if already granted, return the existing row without
    // writing audit. A re-grant of an already-granted scope is a no-op
    // and shouldn't pollute the log on a double-tap.
    if (existing && ConsentService.rowIsGranted(existing)) {
      return this.toRow(existing);
    }

    const updated = await this.prisma.clientCoachConsent.upsert({
      where: {
        ClientCoachConsent_client_coach_scope_key: {
          client_id: clientId,
          coach_id: coachId,
          scope,
        },
      },
      create: {
        client_id: clientId,
        coach_id: coachId,
        scope,
        granted_at: now,
        revoked_at: null,
      },
      update: {
        granted_at: now,
        revoked_at: null,
      },
    });

    await this.audit.write({
      action: ConsentAuditAction.GRANTED,
      actorId: clientId,
      actorRole: 'student',
      targetUserId: clientId,
      targetType: 'consent',
      targetId: updated.id,
      tenantCoachId: coachId,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
      metadata: { scope, coach_id: coachId },
    });

    return this.toRow(updated);
  }

  async revoke(
    clientId: string,
    coachId: string,
    scope: string,
    ctx: AuditContext = {},
  ): Promise<ConsentRow> {
    if (!ConsentService.isKnownScope(scope)) {
      throw new BadRequestException(`Unknown consent scope: ${scope}`);
    }

    const now = new Date();
    const existing = await this.prisma.clientCoachConsent.findUnique({
      where: {
        ClientCoachConsent_client_coach_scope_key: {
          client_id: clientId,
          coach_id: coachId,
          scope,
        },
      },
    });

    // If there's no row OR the row is already revoked, we still record
    // the intent by writing/updating a row but skip the audit emit. The
    // common case here is a UI double-tap — we don't want to log it.
    if (!existing) {
      const created = await this.prisma.clientCoachConsent.create({
        data: {
          client_id: clientId,
          coach_id: coachId,
          scope,
          granted_at: null,
          revoked_at: now,
        },
      });
      return this.toRow(created);
    }

    if (!ConsentService.rowIsGranted(existing)) {
      // Already revoked — return as-is, no audit row.
      return this.toRow(existing);
    }

    const updated = await this.prisma.clientCoachConsent.update({
      where: { id: existing.id },
      data: { revoked_at: now },
    });

    await this.audit.write({
      action: ConsentAuditAction.REVOKED,
      actorId: clientId,
      actorRole: 'student',
      targetUserId: clientId,
      targetType: 'consent',
      targetId: updated.id,
      tenantCoachId: coachId,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
      metadata: { scope, coach_id: coachId },
    });

    return this.toRow(updated);
  }

  // Read-side primitive: is this single (client, coach, scope) granted?
  async isGranted(clientId: string, coachId: string, scope: string): Promise<boolean> {
    const row = await this.prisma.clientCoachConsent.findUnique({
      where: {
        ClientCoachConsent_client_coach_scope_key: {
          client_id: clientId,
          coach_id: coachId,
          scope,
        },
      },
    });
    return ConsentService.rowIsGranted(row);
  }

  // Coach-side gating helper. `coachId` is the caller, `clientId` is the
  // resource owner. Owners bypass the consent check (platform admin can
  // see everything; the audit log records that they did). Coaches must
  // hold a granted consent row for the requested scope.
  //
  // Returns true when access is allowed; callers can throw / 403 / hide
  // data when false. Centralizing the check here means the rule lives in
  // one place and is easy to audit for correctness.
  async coachCanAccess(
    coachId: string,
    clientId: string,
    scope: string,
    callerRole?: string,
  ): Promise<boolean> {
    if (callerRole === 'owner') return true;
    return this.isGranted(clientId, coachId, scope);
  }

  // Admin visibility surface — returns the full consent matrix for a
  // single client across all of their coaches. Used by the OWNER-only
  // /admin/clients/:id/consent endpoint.
  async listForClientAdmin(clientId: string): Promise<{
    client_id: string;
    consents: Array<{
      coach_id: string;
      scope: string;
      granted: boolean;
      granted_at: Date | null;
      revoked_at: Date | null;
      updated_at: Date;
    }>;
  }> {
    const rows = await this.prisma.clientCoachConsent.findMany({
      where: { client_id: clientId },
      orderBy: [{ coach_id: 'asc' }, { scope: 'asc' }],
    });
    return {
      client_id: clientId,
      consents: rows.map((r) => ({
        coach_id: r.coach_id,
        scope: r.scope,
        granted: ConsentService.rowIsGranted(r),
        granted_at: r.granted_at,
        revoked_at: r.revoked_at,
        updated_at: r.updated_at,
      })),
    };
  }
}
