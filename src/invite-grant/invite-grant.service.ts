import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { CoachPackage, InviteGrantMode, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { AuditAction, AuditService } from '../audit/audit.service';
import { CheckoutContractGate } from '../contracts/checkout-contract-gate.service';
import { ContractRequiredException } from '../contracts/contract-required.exception';
import { isContractsEnabled } from '../contracts/contracts.feature';
import { PurchaseFanoutService } from '../packages/purchase-fanout.service';
import { ConsentScope, ConsentService } from '../consent/consent.service';

// Clinic launch C01 — invite-code → package grants and free packages.
//
// A coach binds an invite code (a per-row InviteCode OR the permanent coach
// link code on CoachProfile) to one of their packages with a grant_mode:
//   none    → the code only attaches the client (today's behaviour)
//   free    → on attach the client receives the package for $0
//   prepaid → same grant; the client paid the coach outside the app
// A coach may also price a package at $0; a client of that coach claims it
// via POST /v1/packages/:id/claim-free.
//
// Every grant is the SAME kind of record the paywall already honours: a
// ClientPurchase row with entitlement_active=true, amount_cents=0, a
// synthetic `grant_<uuid>` checkout-session id, `source` set and
// grant_metadata recording provenance. ClientEntitlementGuard and
// CheckoutService.hasActiveEntitlement need no change. Rows with
// source IS NULL are real Stripe purchases and this service never touches
// them. Idempotency: ClientPurchase.idempotency_key is UNIQUE and is
// deterministic per (source, package, client).

export const GRANT_SOURCE = {
  INVITE_FREE: 'invite_grant:free',
  INVITE_PREPAID: 'invite_grant:prepaid',
  FREE_PACKAGE_CLAIM: 'free_package_claim',
} as const;
export type GrantSource = (typeof GRANT_SOURCE)[keyof typeof GRANT_SOURCE];
export const GRANT_SOURCES: readonly string[] = Object.values(GRANT_SOURCE);

export const INVITE_GRANT_MODES: readonly InviteGrantMode[] = ['none', 'free', 'prepaid'];

export type GrantOutcome = {
  purchase_id: string | null;
  /** Present for `pending_consent`: what mobile must do (grant activates automatically after). */
  recovery?: typeof GRANT_CONSENT_RECOVERY;
  /** Present for `code_unavailable`. */
  reason?: string;
  status:
    | 'created'
    | 'already_active'
    | 'revoked_not_regranted'
    /** Bound package is archived / inactive / no longer the coach's — attach still succeeds. */
    | 'package_unavailable'
    /**
     * Contracts are on and the client has not yet ticked the in-app
     * onboarding agreement (owner ruling: one "I agree" box covering the PT
     * waiver + data visibility). The grant row EXISTS (entitlement inactive)
     * and is activated automatically the moment that consent is recorded
     * (POST /consent/grant scope `onboarding.agreement`), or by a retry of
     * POST /v1/invite-codes/:code/claim-grant. See `recovery`.
     */
    | 'pending_consent'
    /** Package requires the coach's own e-sign agreement and it is unsigned (checkout gate, unchanged). */
    | 'contract_required'
    /** The code no longer authorises a NEW grant for this person (revoked / expired / exhausted / other recipient). */
    | 'code_unavailable'
    /** Unexpected error creating the grant — attach still succeeds; logged + audited. */
    | 'failed';
};

/** Status written on revoke. Distinct from Stripe's 'canceled' so churn/subscription readers never see grants. */
export const GRANT_REVOKED_STATUS = 'revoked';

/**
 * Status of a grant row created while the in-app onboarding agreement is
 * still missing (contracts flag ON only). entitlement_active=false, so the
 * paywall stays closed until activation; the row is the client's
 * attributable grant right (no re-redemption of the code is needed).
 */
export const GRANT_PENDING_CONSENT_STATUS = 'pending_consent';

/** The in-app consent that satisfies the waiver for comp grants (owner ruling). */
export const GRANT_CONSENT_SCOPE = ConsentScope.ONBOARDING_AGREEMENT;

/** Machine-readable recovery hint returned with `pending_consent`. */
export const GRANT_CONSENT_RECOVERY = {
  action: 'grant_consent',
  consent_scope: ConsentScope.ONBOARDING_AGREEMENT,
  endpoint: 'POST /consent/grant',
  then: 'automatic',
} as const;

/** Thrown inside a grant transaction when the code cannot authorise a new grant; rolls back any seat bump. */
class CodeUnavailable extends Error {
  constructor(readonly reason: 'revoked' | 'expired' | 'exhausted' | 'recipient_mismatch' | 'not_found') {
    super(`code unavailable: ${reason}`);
  }
}

export type CodeBinding = {
  /** 'profile' = permanent coach link code; 'row' = InviteCode row. */
  kind: 'profile' | 'row';
  coach_id: string;
  invite_code_id: string | null;
  code: string;
  package_id: string | null;
  grant_mode: InviteGrantMode;
};

type GrantActor = { id: string; role: string; email?: string | null };
type Ctx = { ip?: string | null; userAgent?: string | null };

/** The delegates the grant path needs; satisfied by PrismaService and by an interactive `tx`. */
export type GrantDb = Pick<Prisma.TransactionClient, 'clientPurchase' | 'coachPackage'> &
  Partial<Pick<Prisma.TransactionClient, 'inviteCode'>>;

/**
 * One grant row per (package, client) regardless of source: a client who was
 * revoked under a `free` binding is not re-granted when the coach flips the
 * binding to `prepaid` (Opus C2). The source is still recorded on the row.
 */
function grantIdempotencyKey(packageId: string, clientUserId: string): string {
  return `grant:${packageId}:${clientUserId}`;
}

/** Envelope for the 409 the contract gate raises — identical to checkout's. */
function contractRequired(result: Extract<GateResult, { ok: false }>): ContractRequiredException {
  return new ContractRequiredException({
    layer: result.layer,
    envelopeId: result.envelopeId,
    embedUrl: result.embedUrl,
    status: result.status,
  });
}
type GateResult = Awaited<ReturnType<CheckoutContractGate['evaluate']>>;

type PersonRow = {
  id: string;
  email: string;
  name: string | null;
  role: string;
  coach_id: string | null;
};

function accessExpiryFor(
  pkg: { billing_type: string; duration_periods: number | null },
  startedAt: Date,
): Date | null {
  // Mirrors CheckoutWebhookHandler.computeAccessExpiry for one_time packages
  // (duration_periods = weeks). Recurring packages granted for free have no
  // billing cycle to anchor to, so the grant is open-ended until revoked.
  if (pkg.billing_type !== 'one_time' || !pkg.duration_periods) return null;
  return new Date(startedAt.getTime() + pkg.duration_periods * 7 * 24 * 3600 * 1000);
}

@Injectable()
export class InviteGrantService implements OnModuleInit {
  private readonly logger = new Logger(InviteGrantService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    // Optional so the legacy 2-arg construction (and unit doubles) still work.
    // When wired, a grant is delivered exactly like a paid purchase: the
    // package's programs / plans / drips are seeded in the same transaction
    // and the coach's new-client alert is staged, then flushed after commit.
    @Optional() private readonly fanout?: PurchaseFanoutService,
    // Same Layer-1 (platform waiver) / Layer-2 (coach agreement) gate checkout
    // runs BEFORE any Stripe call. A grant is a purchase for the gate's purposes.
    @Optional() private readonly contractGate?: CheckoutContractGate,
    // In-app onboarding agreement (owner ruling) — the consent record that
    // satisfies the waiver for comp grants when contracts are ON.
    @Optional() private readonly consent?: ConsentService,
  ) {}

  onModuleInit(): void {
    // Recovery: the moment a client ticks the onboarding agreement, every
    // pending grant they hold with that coach is activated (no second
    // request, no paywall).
    this.consent?.onGranted((clientId, coachId, scope) =>
      scope === GRANT_CONSENT_SCOPE ? this.activatePendingGrants(clientId, coachId) : undefined,
    );
  }

  // ---------------------------------------------------------------------------
  // Consent / contract gate (Sol SOL-C01-B1, Opus C01-B2)
  // ---------------------------------------------------------------------------

  /**
   * Decide whether a grant may be ACTIVE now.
   *   - contracts flag OFF (production today): always — behaviour unchanged.
   *   - package needs the coach's own e-sign agreement: the checkout gate,
   *     unchanged (such packages cannot be bound to a code anyway).
   *   - otherwise (every comp / free code grant): the in-app onboarding
   *     agreement for this coach is the waiver (owner ruling). The external
   *     platform e-sign waiver is NOT consulted, so clinic clients are never
   *     parked behind an outside signing step.
   * Consent is still enforced: without the record the grant is created
   * PENDING (entitlement inactive) and activates on consent.
   */
  private async evaluateGrantGate(
    client: PersonRow,
    pkg: CoachPackage,
  ): Promise<'ok' | 'consent_required' | Extract<GateResult, { ok: false }> | 'unavailable'> {
    if (!isContractsEnabled()) return 'ok';
    if (pkg.requires_contract && pkg.contract_template_id) {
      if (!this.contractGate) return 'unavailable';
      const coach = await this.prisma.user.findUnique({
        where: { id: pkg.coach_id },
        select: { id: true, email: true, name: true },
      });
      if (!coach) return 'unavailable';
      const result = await this.contractGate.evaluate({
        clientId: client.id,
        client: { email: client.email, name: client.name ?? client.email },
        pkg,
        coach: { id: coach.id, email: coach.email, name: coach.name ?? coach.email },
      });
      return result.ok ? 'ok' : result;
    }
    // Fail closed (pending, recoverable) if the consent service is not wired.
    if (!this.consent) return 'consent_required';
    const agreed = await this.consent.isGranted(client.id, pkg.coach_id, GRANT_CONSENT_SCOPE);
    return agreed ? 'ok' : 'consent_required';
  }

  // ---------------------------------------------------------------------------
  // Bindings
  // ---------------------------------------------------------------------------

  /** Resolve the binding for a code string (permanent coach code first, then InviteCode row). */
  async resolveBinding(code: string): Promise<CodeBinding | null> {
    const profile = await this.prisma.coachProfile.findUnique({
      where: { invite_code: code },
      select: {
        user_id: true,
        invite_code: true,
        invite_code_package_id: true,
        invite_code_grant_mode: true,
      },
    });
    if (profile) {
      return {
        kind: 'profile',
        coach_id: profile.user_id,
        invite_code_id: null,
        code: profile.invite_code,
        package_id: profile.invite_code_package_id,
        grant_mode: profile.invite_code_grant_mode,
      };
    }
    const row = await this.prisma.inviteCode.findUnique({
      where: { code },
      select: { id: true, code: true, coach_id: true, package_id: true, grant_mode: true },
    });
    if (!row) return null;
    return {
      kind: 'row',
      coach_id: row.coach_id,
      invite_code_id: row.id,
      code: row.code,
      package_id: row.package_id,
      grant_mode: row.grant_mode,
    };
  }

  /**
   * Coach/owner sets or clears the package binding on a code they own.
   * `package_id: null` or `grant_mode: 'none'` clears the binding (both are
   * stored as null/none so the row is unambiguous).
   */
  async setBinding(
    actor: GrantActor,
    input: { code: string; package_id: string | null; grant_mode: InviteGrantMode },
    ctx: Ctx = {},
  ): Promise<CodeBinding> {
    const binding = await this.resolveBinding(input.code);
    if (!binding || (actor.role !== 'owner' && binding.coach_id !== actor.id)) {
      // Non-leaking: a coach cannot learn whether another coach's code exists.
      throw new NotFoundException({
        error: 'INVITE_CODE_NOT_FOUND',
        message: 'Invite code not found',
      });
    }

    const clearing = input.package_id === null || input.grant_mode === 'none';
    let packageId: string | null = null;
    let mode: InviteGrantMode = 'none';
    if (!clearing) {
      const pkg = await this.prisma.coachPackage.findUnique({
        where: { id: input.package_id as string },
        select: {
          id: true,
          coach_id: true,
          is_active: true,
          archived_at: true,
          requires_contract: true,
          contract_template_id: true,
        },
      });
      if (!pkg || pkg.coach_id !== binding.coach_id || !pkg.is_active || pkg.archived_at) {
        throw new NotFoundException({
          error: 'PACKAGE_NOT_FOUND',
          message: 'Package not available',
        });
      }
      // A QR / code attach has no signing step. Packages that require the
      // coach service agreement cannot be bound; the gate runs at claim time.
      if (pkg.requires_contract && pkg.contract_template_id) {
        throw new BadRequestException({
          error: 'PACKAGE_REQUIRES_CONTRACT',
          message:
            'Packages that require a signed agreement cannot be granted through an invite code',
        });
      }
      packageId = pkg.id;
      mode = input.grant_mode;
    }

    if (binding.kind === 'profile') {
      await this.prisma.coachProfile.update({
        where: { invite_code: binding.code },
        data: { invite_code_package_id: packageId, invite_code_grant_mode: mode },
      });
    } else {
      await this.prisma.inviteCode.update({
        where: { id: binding.invite_code_id as string },
        data: { package_id: packageId, grant_mode: mode },
      });
    }

    void this.audit.write({
      action: AuditAction.INVITE_CODE_BINDING_SET,
      actorId: actor.id,
      actorRole: actor.role,
      actorEmail: actor.email ?? null,
      tenantCoachId: binding.coach_id,
      targetType: binding.kind === 'profile' ? 'coach_profile_invite_code' : 'invite_code',
      targetId: binding.invite_code_id ?? binding.coach_id,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
      metadata: {
        code_kind: binding.kind,
        previous: { package_id: binding.package_id, grant_mode: binding.grant_mode },
        next: { package_id: packageId, grant_mode: mode },
      },
    });

    return { ...binding, package_id: packageId, grant_mode: mode };
  }

  // ---------------------------------------------------------------------------
  // Grants
  // ---------------------------------------------------------------------------

  /**
   * Create (or report) the single grant row for (package, client). Run inside
   * a transaction (pass `tx`). `active=false` creates the row PENDING
   * (contracts ON, onboarding agreement missing). An existing row is never
   * duplicated: active → already_active; revoked → revoked_not_regranted
   * (re-granting is an explicit coach/owner action); pending → activated when
   * `active` is now true, otherwise still pending.
   */
  async grant(
    input: {
      clientUserId: string;
      coachUserId: string;
      packageId: string;
      source: GrantSource;
      metadata: Record<string, unknown>;
      /** Default true. False → pending_consent row. */
      active?: boolean;
    },
    db: GrantDb = this.prisma,
  ): Promise<GrantOutcome> {
    const active = input.active !== false;
    const pkg = await db.coachPackage.findUnique({ where: { id: input.packageId } });
    if (!pkg || pkg.coach_id !== input.coachUserId || !pkg.is_active || pkg.archived_at) {
      throw new NotFoundException({ error: 'PACKAGE_NOT_FOUND', message: 'Package not available' });
    }

    const idempotencyKey = grantIdempotencyKey(pkg.id, input.clientUserId);
    const now = new Date();
    const sessionId = `grant_${randomUUID()}`;
    // Native ON CONFLICT on the UNIQUE idempotency_key: two concurrent
    // attaches / claims cannot both insert, and the loser never sees P2002
    // (which would abort an enclosing interactive transaction — Opus A2b).
    const row = await db.clientPurchase.upsert({
      where: { idempotency_key: idempotencyKey },
      create: {
        client_user_id: input.clientUserId,
        coach_user_id: input.coachUserId,
        package_id: pkg.id,
        amount_cents: 0,
        currency: pkg.currency,
        billing_type: pkg.billing_type,
        // Synthetic, never sent to Stripe. The `grant_` prefix keeps it out
        // of the `cs_` namespace so no reconciliation code can mistake it.
        stripe_checkout_session_id: sessionId,
        status: active ? 'active' : GRANT_PENDING_CONSENT_STATUS,
        entitlement_active: active,
        access_expires_at: active ? accessExpiryFor(pkg, now) : null,
        idempotency_key: idempotencyKey,
        source: input.source,
        grant_metadata: {
          ...input.metadata,
          ...(active ? { granted_at: now.toISOString() } : { pending_since: now.toISOString() }),
        } as Prisma.InputJsonValue,
      },
      update: {},
      select: {
        id: true,
        status: true,
        entitlement_active: true,
        stripe_checkout_session_id: true,
        grant_metadata: true,
      },
    });

    if (row.stripe_checkout_session_id !== sessionId) {
      // Pre-existing row.
      if (row.entitlement_active) return { purchase_id: row.id, status: 'already_active' };
      if (row.status === GRANT_PENDING_CONSENT_STATUS) {
        if (!active) {
          return { purchase_id: row.id, status: 'pending_consent', recovery: GRANT_CONSENT_RECOVERY };
        }
        return this.activateRow(row, pkg, input, now, db);
      }
      this.logger.warn(
        `grant skipped: client=${input.clientUserId} package=${pkg.id} source=${input.source} was revoked`,
      );
      return { purchase_id: row.id, status: 'revoked_not_regranted' };
    }

    if (!active) {
      void this.audit.write({
        action: AuditAction.ENTITLEMENT_GRANT_SKIPPED,
        actorId: input.clientUserId,
        actorRole: 'student',
        tenantCoachId: input.coachUserId,
        targetUserId: input.clientUserId,
        targetType: 'client_purchase',
        targetId: row.id,
        metadata: { source: input.source, package_id: pkg.id, reason: 'pending_consent', ...input.metadata },
      });
      return { purchase_id: row.id, status: 'pending_consent', recovery: GRANT_CONSENT_RECOVERY };
    }

    await this.deliver(row.id, input, now, db);
    return { purchase_id: row.id, status: 'created' };
  }

  /** Flip a pending row to active (conditional on it still being pending) and deliver it. */
  private async activateRow(
    row: { id: string; grant_metadata: Prisma.JsonValue | null },
    pkg: CoachPackage,
    input: { clientUserId: string; coachUserId: string; source: GrantSource; metadata: Record<string, unknown> },
    now: Date,
    db: GrantDb,
  ): Promise<GrantOutcome> {
    const prior = (row.grant_metadata ?? {}) as Record<string, unknown>;
    const flipped = await db.clientPurchase.updateMany({
      where: { id: row.id, status: GRANT_PENDING_CONSENT_STATUS, entitlement_active: false },
      data: {
        status: 'active',
        entitlement_active: true,
        access_expires_at: accessExpiryFor(pkg, now),
        grant_metadata: { ...prior, granted_at: now.toISOString() } as Prisma.InputJsonValue,
      },
    });
    // A concurrent activation won: converge on already_active.
    if (flipped.count !== 1) return { purchase_id: row.id, status: 'already_active' };
    await this.deliver(row.id, input, now, db);
    return { purchase_id: row.id, status: 'created' };
  }

  /** Fan-out + audit for a grant that just became active. */
  private async deliver(
    purchaseId: string,
    input: { clientUserId: string; coachUserId: string; source: GrantSource; metadata: Record<string, unknown>; packageId?: string },
    now: Date,
    db: GrantDb,
  ): Promise<void> {
    // Deliver the package like a paid purchase (Opus A1): seed drops for the
    // package contents and stage the coach's new-client alert, in the SAME
    // transaction as the grant row.
    if (this.fanout) {
      await this.fanout.onPurchaseEntitled(
        { id: purchaseId },
        {
          entrypoint:
            input.source === GRANT_SOURCE.FREE_PACKAGE_CLAIM ? 'free_package_claim' : 'invite_grant',
          coachId: input.coachUserId,
          clientId: input.clientUserId,
          purchaseTime: now,
        },
        db as Prisma.TransactionClient,
      );
    }
    void this.audit.write({
      action: AuditAction.ENTITLEMENT_GRANTED,
      actorId: input.clientUserId,
      actorRole: 'student',
      tenantCoachId: input.coachUserId,
      targetUserId: input.clientUserId,
      targetType: 'client_purchase',
      targetId: purchaseId,
      metadata: { source: input.source, ...input.metadata },
    });
  }

  /** Post-commit hook: fire the staged drip / coach-new-client alerts for a grant. */
  flushAfterCommit(outcome: GrantOutcome | null | undefined): void {
    if (outcome?.status === 'created' && outcome.purchase_id) {
      this.fanout?.flushAlerts(outcome.purchase_id);
    }
  }

  /**
   * Sol SOL-C01-A2 — the code must authorise a NEW grant for THIS person.
   * Runs inside the grant transaction; throws CodeUnavailable (rolling back
   * any seat bump) when it does not.
   *   - permanent coach code: the coach's public link, no recipient → ok.
   *   - InviteCode row: revoked → never; the recorded first redeemer → ok
   *     without another seat (their redemption already paid for it);
   *     otherwise not expired, intended recipient matches, and ONE seat is
   *     consumed (conditional on capacity), exactly like an attach.
   */
  private async authorizeCodeForNewGrant(
    db: GrantDb,
    binding: CodeBinding,
    client: { id: string; email: string | null },
  ): Promise<void> {
    if (binding.kind === 'profile') return;
    if (!db.inviteCode || !binding.invite_code_id) throw new CodeUnavailable('not_found');
    const row = await db.inviteCode.findUnique({ where: { id: binding.invite_code_id } });
    if (!row) throw new CodeUnavailable('not_found');
    if (row.revoked) throw new CodeUnavailable('revoked');
    if (row.accepted_by_user_id && row.accepted_by_user_id === client.id) return;
    if (row.expires_at && row.expires_at.getTime() <= Date.now()) throw new CodeUnavailable('expired');
    if (row.intended_email) {
      const mine = (client.email ?? '').toLowerCase().trim();
      if (mine !== row.intended_email.toLowerCase().trim()) throw new CodeUnavailable('recipient_mismatch');
    }
    const bumped = await db.inviteCode.updateMany({
      where: {
        id: row.id,
        revoked: false,
        ...(row.max_uses !== null ? { used_count: { lt: row.max_uses } } : {}),
      },
      data: { used_count: { increment: 1 } },
    });
    if (bumped.count !== 1) throw new CodeUnavailable('exhausted');
    if (!row.accepted_by_user_id) {
      await db.inviteCode.updateMany({
        where: { id: row.id, accepted_by_user_id: null },
        data: { accepted_by_user_id: client.id, accepted_at: new Date() },
      });
    }
  }

  private bindingMetadata(binding: CodeBinding): Record<string, unknown> {
    return {
      invite_code_id: binding.invite_code_id,
      invite_code: binding.code,
      code_kind: binding.kind,
      package_id: binding.package_id,
      grant_mode: binding.grant_mode,
    };
  }

  /**
   * Shared core for attach-time grants and explicit claims.
   *   redemption 'new'    → the attach that just committed consumed the seat
   *                         and checked recipient/lifecycle: that IS the right.
   *   redemption 'replay' → the client was already attached to this coach. An
   *                         existing grant row for (package, client) is the
   *                         right (report / activate it). With no row, the code
   *                         must authorise a NEW grant for this person
   *                         (authorizeCodeForNewGrant), atomically with the row.
   */
  private async grantForBinding(input: {
    client: PersonRow;
    coachUserId: string;
    binding: CodeBinding;
    pkg: CoachPackage;
    redemption: 'new' | 'replay';
    extraMetadata?: Record<string, unknown>;
  }): Promise<GrantOutcome | Extract<GateResult, { ok: false }> | 'unavailable'> {
    const { client, binding, pkg } = input;
    const gate = await this.evaluateGrantGate(client, pkg);
    if (gate !== 'ok' && gate !== 'consent_required') return gate;
    const source =
      binding.grant_mode === 'free' ? GRANT_SOURCE.INVITE_FREE : GRANT_SOURCE.INVITE_PREPAID;
    const metadata = { ...this.bindingMetadata(binding), ...(input.extraMetadata ?? {}) };
    const active = gate === 'ok';
    try {
      const outcome = await this.prisma.$transaction(async (tx) => {
        if (input.redemption === 'replay') {
          const existing = await tx.clientPurchase.findUnique({
            where: { idempotency_key: grantIdempotencyKey(pkg.id, client.id) },
            select: { id: true, status: true },
          });
          if (!existing) {
            await this.authorizeCodeForNewGrant(tx, binding, client);
          } else if (existing.status === GRANT_PENDING_CONSENT_STATUS && binding.kind === 'row') {
            // A pending right is honoured across expiry/exhaustion (it was
            // redeemed in time), but a code the coach REVOKED is not reopened.
            const row = await tx.inviteCode.findUnique({
              where: { id: binding.invite_code_id as string },
              select: { revoked: true },
            });
            if (!row || row.revoked) throw new CodeUnavailable('revoked');
          }
        }
        return this.grant(
          { clientUserId: client.id, coachUserId: input.coachUserId, packageId: pkg.id, source, metadata, active },
          tx,
        );
      });
      this.flushAfterCommit(outcome);
      return outcome;
    } catch (err) {
      if (err instanceof CodeUnavailable) {
        return { purchase_id: null, status: 'code_unavailable', reason: err.reason };
      }
      throw err;
    }
  }

  /**
   * Called by InviteCodesService AFTER every successful attach — a new
   * redemption or a same-coach idempotent replay — never after a refusal.
   * Never throws: the attach has already succeeded; a grant that cannot be
   * made is reported, logged and audited.
   */
  async grantForAttachedCode(input: {
    clientUserId: string;
    coachUserId: string;
    binding: CodeBinding;
    redemption: 'new' | 'replay';
  }): Promise<GrantOutcome | null> {
    const { binding } = input;
    if (binding.grant_mode === 'none' || !binding.package_id) return null;
    if (binding.coach_id !== input.coachUserId) return null; // binding must belong to the attach coach
    const packageId = binding.package_id;
    const metadata = this.bindingMetadata(binding);

    const skip = (status: 'package_unavailable' | 'contract_required' | 'failed', detail: string) => {
      this.logger.warn(
        `grant skipped (${status}): client=${input.clientUserId} coach=${input.coachUserId} package=${packageId} code=${binding.code} — ${detail}`,
      );
      void this.audit.write({
        action: AuditAction.ENTITLEMENT_GRANT_SKIPPED,
        actorId: input.clientUserId,
        actorRole: 'student',
        tenantCoachId: input.coachUserId,
        targetUserId: input.clientUserId,
        targetType: 'coach_package',
        targetId: packageId,
        metadata: { ...metadata, reason: status, detail },
      });
      return { purchase_id: null, status } as GrantOutcome;
    };

    try {
      const pkg = await this.prisma.coachPackage.findUnique({ where: { id: packageId } });
      if (!pkg || pkg.coach_id !== input.coachUserId || !pkg.is_active || pkg.archived_at) {
        return skip('package_unavailable', 'bound package is missing, archived, inactive or moved coach');
      }
      const client = await this.prisma.user.findUnique({
        where: { id: input.clientUserId },
        select: { id: true, email: true, name: true, role: true, coach_id: true },
      });
      if (!client) return skip('failed', 'client row not found');
      if (client.role !== 'student' || client.coach_id !== input.coachUserId) {
        return skip('failed', 'client is not attached to the binding coach');
      }
      const out = await this.grantForBinding({
        client,
        coachUserId: input.coachUserId,
        binding,
        pkg,
        redemption: input.redemption,
      });
      if (out === 'unavailable' || !('status' in out && 'purchase_id' in out)) {
        return skip(
          'contract_required',
          out === 'unavailable' ? 'contract gate unavailable' : `${(out as any).layer} unsigned`,
        );
      }
      return out;
    } catch (err) {
      return skip('failed', err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * An already-attached client of the code's coach claims the grant a bound
   * code carries (web /join page for existing clients; retry after consent).
   * Sol SOL-C01-A2: coach membership is NOT permission — the client must
   * hold the grant right (an existing grant row) or the code must authorise
   * a new grant for them (recipient, lifecycle, one seat).
   */
  async claimGrantForCode(
    client: { id: string; role: string; coach_id: string | null },
    code: string,
  ): Promise<GrantOutcome> {
    if (client.role !== 'student') {
      throw new ForbiddenException({ error: 'CLIENT_ONLY', message: 'Only clients can claim a grant' });
    }
    const binding = await this.resolveBinding(code.trim());
    if (!binding || !client.coach_id || binding.coach_id !== client.coach_id) {
      throw new NotFoundException({ error: 'INVITE_CODE_NOT_FOUND', message: 'Invite code not found' });
    }
    if (binding.grant_mode === 'none' || !binding.package_id) {
      throw new BadRequestException({ error: 'CODE_HAS_NO_GRANT', message: 'This code does not carry a package' });
    }
    const pkg = await this.prisma.coachPackage.findUnique({ where: { id: binding.package_id } });
    if (!pkg || pkg.coach_id !== binding.coach_id || !pkg.is_active || pkg.archived_at) {
      throw new NotFoundException({ error: 'PACKAGE_NOT_FOUND', message: 'Package not available' });
    }
    const person = await this.prisma.user.findUnique({
      where: { id: client.id },
      select: { id: true, email: true, name: true, role: true, coach_id: true },
    });
    if (!person) throw new NotFoundException({ error: 'CLIENT_NOT_FOUND', message: 'Client not found' });
    const out = await this.grantForBinding({
      client: person,
      coachUserId: binding.coach_id,
      binding,
      pkg,
      redemption: 'replay',
      extraMetadata: { claimed_by: client.id },
    });
    if (out === 'unavailable') {
      throw new BadRequestException({
        error: 'PACKAGE_REQUIRES_CONTRACT',
        message: 'This package requires a signed agreement and the signing service is unavailable',
      });
    }
    if (!('purchase_id' in out)) throw contractRequired(out);
    if (out.status === 'code_unavailable') {
      throw new ConflictException({
        error: 'INVITE_CODE_UNAVAILABLE',
        reason: out.reason,
        message: 'This code can no longer grant a package to you',
      });
    }
    return out;
  }

  /** A client of the package's coach claims a $0 package. Non-free packages must go through Stripe. */
  async claimFreePackage(
    client: { id: string; role: string; coach_id: string | null },
    packageId: string,
  ): Promise<GrantOutcome> {
    if (client.role !== 'student') {
      throw new ForbiddenException({ error: 'CLIENT_ONLY', message: 'Only clients can claim a package' });
    }
    const pkg = await this.prisma.coachPackage.findUnique({ where: { id: packageId } });
    // Non-leaking 404 for another coach's package (same rule as checkout).
    if (
      !pkg ||
      !client.coach_id ||
      pkg.coach_id !== client.coach_id ||
      !pkg.is_active ||
      pkg.archived_at ||
      !pkg.published_at
    ) {
      throw new NotFoundException({ error: 'PACKAGE_NOT_FOUND', message: 'Package not available' });
    }
    if (pkg.amount_cents !== 0) {
      throw new BadRequestException({
        error: 'PACKAGE_NOT_FREE',
        message: 'This package is not free; purchase it through checkout',
      });
    }
    const person = await this.prisma.user.findUnique({
      where: { id: client.id },
      select: { id: true, email: true, name: true, role: true, coach_id: true },
    });
    if (!person) throw new NotFoundException({ error: 'CLIENT_NOT_FOUND', message: 'Client not found' });
    const gate = await this.evaluateGrantGate(person, pkg);
    if (gate === 'unavailable') {
      throw new BadRequestException({
        error: 'PACKAGE_REQUIRES_CONTRACT',
        message: 'This package requires a signed agreement and the signing service is unavailable',
      });
    }
    if (gate !== 'ok' && gate !== 'consent_required') throw contractRequired(gate);
    const outcome = await this.prisma.$transaction((tx) =>
      this.grant(
        {
          clientUserId: client.id,
          coachUserId: pkg.coach_id,
          packageId: pkg.id,
          source: GRANT_SOURCE.FREE_PACKAGE_CLAIM,
          metadata: { package_id: pkg.id, claimed_by: client.id },
          active: gate === 'ok',
        },
        tx,
      ),
    );
    this.flushAfterCommit(outcome);
    return outcome;
  }

  /**
   * Consent recovery: activate every PENDING grant (client, coach) once the
   * onboarding agreement is recorded. Re-checks package availability and
   * code revocation per row. Never throws (called from ConsentService).
   */
  async activatePendingGrants(clientId: string, coachId: string): Promise<GrantOutcome[]> {
    const out: GrantOutcome[] = [];
    try {
      const rows = await this.prisma.clientPurchase.findMany({
        where: {
          client_user_id: clientId,
          coach_user_id: coachId,
          status: GRANT_PENDING_CONSENT_STATUS,
          entitlement_active: false,
          source: { in: [...GRANT_SOURCES] },
        },
        select: { id: true, package_id: true, source: true, grant_metadata: true },
      });
      for (const r of rows) {
        const meta = (r.grant_metadata ?? {}) as Record<string, unknown>;
        if (typeof meta.invite_code_id === 'string') {
          const code = await this.prisma.inviteCode.findUnique({
            where: { id: meta.invite_code_id },
            select: { revoked: true },
          });
          if (!code || code.revoked) continue; // a revoked code is not reopened
        }
        const pkg = await this.prisma.coachPackage.findUnique({ where: { id: r.package_id } });
        if (!pkg || pkg.coach_id !== coachId || !pkg.is_active || pkg.archived_at) continue;
        const person = await this.prisma.user.findUnique({
          where: { id: clientId },
          select: { id: true, email: true, name: true, role: true, coach_id: true },
        });
        if (!person || person.role !== 'student' || person.coach_id !== coachId) continue;
        if ((await this.evaluateGrantGate(person, pkg)) !== 'ok') continue;
        const outcome = await this.prisma.$transaction((tx) =>
          this.grant(
            {
              clientUserId: clientId,
              coachUserId: coachId,
              packageId: pkg.id,
              source: r.source as GrantSource,
              metadata: meta,
              active: true,
            },
            tx,
          ),
        );
        this.flushAfterCommit(outcome);
        out.push(outcome);
      }
    } catch (err) {
      this.logger.warn(
        `activatePendingGrants failed client=${clientId} coach=${coachId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Revoke
  // ---------------------------------------------------------------------------

  /**
   * Revoke grant rows (source IS NOT NULL) for a client. Coaches only for
   * their own roster; owner for anyone. Stripe purchases are never touched.
   * Idempotent: already-revoked rows are not counted.
   */
  async revoke(
    actor: GrantActor,
    input: { client_user_id: string; package_id?: string; reason?: string },
    ctx: Ctx = {},
  ): Promise<{ revoked: number; purchase_ids: string[] }> {
    const client = await this.prisma.user.findUnique({
      where: { id: input.client_user_id },
      select: { id: true, coach_id: true },
    });
    const coachScope = actor.role === 'owner' ? null : actor.id;
    if (!client || (coachScope && client.coach_id !== coachScope)) {
      throw new NotFoundException({ error: 'CLIENT_NOT_FOUND', message: 'Client not found' });
    }

    const rows = await this.prisma.clientPurchase.findMany({
      where: {
        client_user_id: client.id,
        source: { in: [...GRANT_SOURCES] },
        entitlement_active: true,
        ...(coachScope ? { coach_user_id: coachScope } : {}),
        ...(input.package_id ? { package_id: input.package_id } : {}),
      },
      select: {
        id: true,
        coach_user_id: true,
        package_id: true,
        source: true,
        grant_metadata: true,
      },
    });
    if (rows.length === 0) return { revoked: 0, purchase_ids: [] };

    const now = new Date();
    for (const row of rows) {
      const prior = (row.grant_metadata ?? {}) as Record<string, unknown>;
      await this.prisma.clientPurchase.update({
        where: { id: row.id },
        data: {
          entitlement_active: false,
          // Not 'canceled': churn / subscription readers key on that status
          // for Stripe subscriptions. The guard rejects anything outside
          // paid/active/trialing, so 'revoked' closes the paywall.
          status: GRANT_REVOKED_STATUS,
          canceled_at: now,
          grant_metadata: {
            ...prior,
            revoked_at: now.toISOString(),
            revoked_by_user_id: actor.id,
            revoke_reason: input.reason ?? null,
          } as Prisma.InputJsonValue,
        },
      });
      // Stop future drops for the grant, mirroring refunds.
      if (this.fanout) {
        await this.fanout.cancelPendingForPurchase(row.id, 'grant_revoked');
      }
      void this.audit.write({
        action: AuditAction.ENTITLEMENT_GRANT_REVOKED,
        actorId: actor.id,
        actorRole: actor.role,
        actorEmail: actor.email ?? null,
        tenantCoachId: row.coach_user_id,
        targetUserId: client.id,
        targetType: 'client_purchase',
        targetId: row.id,
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
        metadata: { source: row.source, package_id: row.package_id, reason: input.reason ?? null },
      });
    }
    return { revoked: rows.length, purchase_ids: rows.map((r) => r.id) };
  }
}
