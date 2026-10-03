import * as crypto from 'crypto';
import {
  Injectable,
  InternalServerErrorException,
  Logger,
  Optional,
  UnauthorizedException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
  NotFoundException,
} from '@nestjs/common';
import { createClient } from '@supabase/supabase-js';
// Named import (not `import ws from 'ws'`) — see supabase.service.ts for why.
import { WebSocket as WS } from 'ws';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import {
  InviteCodesService,
  INVITE_CODE_MAX_LENGTH,
  INVITE_CODE_MIN_LENGTH,
  INVITE_CODE_PREFIX,
  generateInviteCodeCandidate,
  coachCannotRedeemBody,
  isCoachLikeRole,
  inviteAttachErrorCode,
  INVITE_ATTACH_ERROR,
  type InviteAttachErrorCode,
  type AttachGrant,
} from '../invite-codes/invite-codes.service';
import type { IntendedRole } from './auth.dto';
import { normalizeEmail } from './email-normalize';
import { LoginThrottleResetService } from '../throttler/login-throttle-reset.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { Events } from '../analytics/events';
import { AuditAction, AuditService, AuditWriteInput } from '../audit/audit.service';
import { AppleVerifierService } from './apple-verifier.service';
import { GoogleVerifierService } from './google-verifier.service';
import {
  issueRecentAuthToken,
  parseTtlMs,
  RECENT_AUTH_SECRET_MIN_LENGTH,
  RECENT_AUTH_TTL_MS as RECENT_AUTH_TTL_DEFAULT_MS,
} from './recent-auth.guard';
import { roleSatisfies } from './roles.guard';
import type { AppRole } from '../common/decorators/roles.decorator';

// Self-service promotion to coach is the legacy behavior of POST
// /auth/become-coach. It is a privilege-escalation hole on a sale-ready
// enterprise tenant — any client with their password could become a coach.
// The endpoint is hard-gated off by default. To re-enable for legacy
// migrations, set ALLOW_SELF_SERVICE_BECOME_COACH=true; the canonical
// path remains OWNER-only POST /admin/users/:id/promote.
function selfServiceBecomeCoachEnabled(): boolean {
  return (process.env.ALLOW_SELF_SERVICE_BECOME_COACH ?? '').toLowerCase() === 'true';
}

// Clinic launch C13 (owner direction 2026-09-30, supersedes the "no
// self-promotion" clause of R-ONBOARDING-ROLE-GATE-1 for SIGNUP TIME ONLY):
// a brand-new account may be created directly as a coach. This is not a
// runtime escalation — there is no existing account, no roster, no data —
// and it goes through exactly one code path (`createSignupUser`) that every
// signup provider shares. The gate above is untouched: an EXISTING account
// can still only become a coach via OWNER promote (or the legacy env-gated
// become-coach).
//
// Attempts to find an unused CoachProfile.invite_code before the signup tx.
const SIGNUP_COACH_CODE_ATTEMPTS = 8;
// Re-runs of the coach signup transaction when the pre-checked invite code
// loses a P2002 race on CoachProfile.invite_code (the whole tx is retried
// with a fresh code; nothing else is retried).
const SIGNUP_COACH_TX_ATTEMPTS = 3;

// Kill switch (fix round, Opus B2 / Grok C7). Default ON. When 'false' | '0' |
// 'off', `intended_role` is accepted by the DTOs (so older/newer app builds
// never get a 400) but IGNORED: every signup creates a client, and
// /auth/signup-policy reports `role_choice: false` so the picker is hidden.
export function signupRoleChoiceEnabled(): boolean {
  const v = (process.env.SIGNUP_ROLE_CHOICE_ENABLED ?? 'true').trim().toLowerCase();
  return v !== 'false' && v !== '0' && v !== 'off';
}

// Grok B3: Supabase's enumeration protection answers `signUp` for an
// already-registered address with a placeholder user (`identities: []`) and
// no error. Treat that exactly like our own duplicate check.
function isObfuscatedExistingSupabaseUser(
  user: { identities?: unknown } | null | undefined,
): boolean {
  return !!user && Array.isArray(user.identities) && user.identities.length === 0;
}

// A-597-1 (Sol): a P2002 on User.email / User.supabase_id means a competing
// signup for the same address committed first. The winner owns the Supabase
// identity (Supabase returns the SAME unconfirmed user to both callers), so
// the loser must never delete it.
function isSignupIdentityUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false;
  const target = (err.meta as { target?: unknown } | undefined)?.target;
  const fields = Array.isArray(target)
    ? target.map(String)
    : typeof target === 'string'
      ? [target]
      : [];
  return fields.some((f) => f.includes('email') || f.includes('supabase_id'));
}

// A-597-1: per-request ownership marker written into the Supabase user's
// metadata at signUp. Supabase never updates an existing unconfirmed user on
// a repeated signUp ("do not update the user because we can't be sure of
// their claimed identity", auth signup.go), so the marker on the returned
// user names the request that CREATED the identity.
//
// Fix round 4: the marker is `<nonce>.<HMAC-SHA256(server key, canonical email)>`
// so only THIS server can mint one. `user_metadata` is writable through the
// public anon `signUp`, so an unauthenticated marker would let anyone label an
// identity "created by /auth/register"; the MAC makes stranded-identity
// adoption (`adoptStrandedSignupIdentity`) no wider than a normal register.
// Keyed with the service-role key (never sent anywhere); without a key no
// marker verifies and adoption is simply off.
export const SIGNUP_ATTEMPT_METADATA_KEY = 'tgp_signup_attempt';
function signupAttemptMarker(user: { user_metadata?: unknown } | null | undefined): string | null {
  const meta = user?.user_metadata;
  if (!meta || typeof meta !== 'object') return null;
  const v = (meta as Record<string, unknown>)[SIGNUP_ATTEMPT_METADATA_KEY];
  return typeof v === 'string' ? v : null;
}
function signupAttemptMac(canonicalEmail: string): string | null {
  // MAC over the canonical address only (the caller-typed address, never any
  // value read back from Supabase); the nonce travels in clear and only makes
  // each request's marker unique for the creator check in `register`.
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (key.length < 16) return null;
  return crypto
    .createHmac('sha256', key)
    .update(`tgp-signup-attempt:v2:${canonicalEmail}`)
    .digest('base64url');
}
export function mintSignupAttemptMarker(canonicalEmail: string): string {
  return `${crypto.randomUUID()}.${signupAttemptMac(canonicalEmail) ?? 'unsigned'}`;
}
export function isServerMintedSignupMarker(marker: string | null, canonicalEmail: string): boolean {
  if (!marker) return false;
  const dot = marker.indexOf('.');
  if (dot <= 0) return false;
  const expected = signupAttemptMac(canonicalEmail);
  if (!expected) return false;
  const got = Buffer.from(marker.slice(dot + 1));
  const want = Buffer.from(expected);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// Opus B-597-2: proof that the caller knows the password of a Supabase
// identity it did NOT create. GoTrue checks the password BEFORE the
// confirmation state (auth token.go: `invalid_credentials` first, then
// `email_not_confirmed`), so `email_not_confirmed` means "right password,
// still unconfirmed". Anything else is not proof.
function isEmailNotConfirmedError(
  error: { code?: unknown; message?: unknown } | null | undefined,
): boolean {
  if (!error) return false;
  if (error.code === 'email_not_confirmed') return true;
  return typeof error.message === 'string' && /email not confirmed/i.test(error.message);
}
function isInviteCodeUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false;
  const target = (err.meta as { target?: unknown } | undefined)?.target;
  const fields = Array.isArray(target)
    ? target.map(String)
    : typeof target === 'string'
      ? [target]
      : [];
  return fields.some((f) => f.includes('invite_code'));
}

type SignupProvider = 'email' | 'google' | 'apple';
// `throttleIp` (Opus C13-C1) is the TRUSTED client IP the rate limiter uses
// (Fly-Client-IP first, same resolution as UserThrottlerGuard). `ip` stays the
// audit-row IP. The OAuth coach-signup ceiling must never key on the
// client-controlled first X-Forwarded-For hop.
type AuditCtx = { ip?: string | null; userAgent?: string | null; throttleIp?: string | null };

@Injectable()
export class AuthService {
  private supabaseAdmin;
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private prisma: PrismaService,
    private inviteCodes: InviteCodesService,
    private analytics: AnalyticsService,
    private audit: AuditService,
    private appleVerifier: AppleVerifierService,
    private googleVerifier: GoogleVerifierService,
    // Optional so the many hand-built AuthService test doubles keep compiling;
    // AuthModule always wires it (ThrottlerModule is imported there).
    @Optional() private loginThrottle?: LoginThrottleResetService,
  ) {
    // Supabase Admin SDK for user management (service role key).
    // Node 20 lacks native WebSocket; supabase-js >=2.105 requires an explicit
    // transport when running under Node <22.
    this.supabaseAdmin = createClient(
      process.env.SUPABASE_URL || '',
      process.env.SUPABASE_SERVICE_ROLE_KEY || '',
      { realtime: { transport: WS as any } },
    );
  }

  private withAuthTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
    const MS = 10_000;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`AUTH_TIMEOUT:${label}`));
      }, MS);
      promise.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }

  // Clinic launch C03 — one attach path for signup-with-code / Google / Apple.
  // The auth call itself never fails because of the attach (the user IS
  // signed in and can retry via /auth/attach-invite-code), but the outcome is
  // no longer swallowed: callers get `invite_attached` plus a safe reason
  // code in `invite_attach_error` and mobile can show the right screen.
  private async tryAttachInviteCode(
    flow: 'signupWithCode' | 'googleAuth' | 'appleAuth',
    userId: string,
    inviteCode: string,
  ): Promise<{
    invite_attached: boolean;
    invite_attach_error?: InviteAttachErrorCode;
    invite_grant?: AttachGrant | null;
  }> {
    try {
      const res = await this.inviteCodes.attachUserToCoachByCode(userId, inviteCode);
      // C01: the package-grant outcome (created / already_active /
      // pending_consent + recovery / ...) travels with every signup path so
      // mobile never has to guess whether the client is paywalled.
      return { invite_attached: true, ...(res.grant ? { invite_grant: res.grant } : {}) };
    } catch (err) {
      const code = inviteAttachErrorCode(err);
      this.logger.warn(
        `${flow} invite_code attach failed for user=${userId} code=${code}: ${(err as Error).message}`,
      );
      return { invite_attached: false, invite_attach_error: code };
    }
  }

  // ---- C13: signup-time role choice --------------------------------------
  //
  // The ONLY place a client-supplied role reaches the User table. Called by
  // register / googleAuth / appleAuth strictly on the "no local row exists"
  // branch; existing rows never pass through here.
  //
  //   intended_role absent | 'client'  -> `role: 'student'` via the exact same
  //                                        prisma.user.create as before.
  //   intended_role 'coach'            -> ONE transaction: User(role coach) +
  //                                        CoachSubscription upsert
  //                                        {tier free, status active, update {}}
  //                                        (identical to becomeCoach; never
  //                                        overwrites a row) + CoachProfile with
  //                                        a fresh GP- invite code (what
  //                                        /coaches/me/invite-link would
  //                                        otherwise lazily mint). Then a
  //                                        USER_ROLE_CHANGED audit row with
  //                                        actor = the new user.
  //
  // A new coach is created with coach_id = null (forced, Grok C1) and no
  // invite code is ever redeemed on this path, so the "student with a
  // coach_id becomes a coach" combination cannot arise here. The reverse
  // direction (a coach gaining a coach_id through guest checkout or a code)
  // is closed in GuestCheckoutService / InviteCodesService (fix round A1/B1).
  //
  // Fix round: the user.role_changed audit row is written INSIDE the
  // transaction with the throwing AuditService.writeTx, so a coach row can
  // never exist without its audit row (Opus B3 / Grok B2). actorRole is null:
  // there was no prior role (becomeCoach records the old role, 'student').
  private async createSignupUser(
    data: Prisma.UserUncheckedCreateInput,
    intendedRole: IntendedRole | undefined,
    provider: SignupProvider,
    ctx: AuditCtx = {},
    opts: { inviteCode?: string } = {},
  ) {
    if (this.effectiveIntendedRole(intendedRole) !== 'coach') {
      return this.prisma.user.create({ data: { ...data, role: 'student' } });
    }

    let inviteCode = opts.inviteCode ?? (await this.pickUnusedCoachInviteCode());
    const auditBase: Omit<
      AuditWriteInput,
      'actorId' | 'targetUserId' | 'targetId' | 'tenantCoachId' | 'actorEmail'
    > = {
      action: AuditAction.USER_ROLE_CHANGED,
      actorRole: null,
      targetType: 'user',
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
      metadata: { from: null, to: 'coach', via: 'signup_role_choice', provider },
    };

    for (let attempt = 1; ; attempt++) {
      try {
        const user = await this.prisma.$transaction(async (tx) => {
          const created = await tx.user.create({
            data: { ...data, role: 'coach', coach_id: null },
          });
          // Same shape as becomeCoach: `update: {}` never touches an existing row.
          await tx.coachSubscription.upsert({
            where: { coach_id: created.id },
            create: { coach_id: created.id, tier: 'free', status: 'active' },
            update: {},
          });
          // Grok C5: `plan_tier` / `ai_monthly_spend_cap_cents` keep their
          // schema defaults (flat_300 / 5000) exactly like promoteUser and
          // becomeCoach. Neither is load-bearing for entitlements: the AI
          // envelope is CoachAIBudget (tier-aware, see ai-credits), and the
          // sub-coach capacity map already resolves unknown tiers to the
          // flat_300 value. Introducing a new tier string here would be a
          // schema-level decision, not a signup one.
          await tx.coachProfile.create({
            data: { user_id: created.id, invite_code: inviteCode },
          });
          // Reviewable like every other elevation: actor = target so operators
          // scanning user.role_changed see signup-time coaches next to promote /
          // become-coach rows. Throws -> whole transaction rolls back.
          await this.audit.writeTx(tx, {
            ...auditBase,
            actorId: created.id,
            actorEmail: created.email,
            targetUserId: created.id,
            targetId: created.id,
            tenantCoachId: created.id,
          });
          return created;
        });
        this.analytics.capture(user.id, Events.COACH_PROMOTED, {
          via: 'signup_role_choice',
          provider,
          tier: 'free',
        });
        return user;
      } catch (err) {
        // Only the invite-code race is retried (Grok B3 / Opus C10): the
        // pre-check ran outside the tx, so a concurrent coach signup can
        // still win the same code. Anything else (email/supabase_id P2002,
        // audit failure, DB outage) propagates unchanged.
        if (isInviteCodeUniqueViolation(err) && attempt < SIGNUP_COACH_TX_ATTEMPTS) {
          this.logger.warn(
            `createSignupUser: invite code collision on attempt ${attempt}, retrying with a fresh code`,
          );
          inviteCode = await this.pickUnusedCoachInviteCode();
          continue;
        }
        throw err;
      }
    }
  }

  // CoachProfile.invite_code is @unique. A unique violation inside an
  // interactive transaction aborts it, so we pick a free candidate up front
  // (31^6 space; a collision after this check is astronomically unlikely and
  // is retried once more by createSignupUser).
  private async pickUnusedCoachInviteCode(): Promise<string> {
    for (let attempt = 0; attempt < SIGNUP_COACH_CODE_ATTEMPTS; attempt++) {
      const candidate = generateInviteCodeCandidate();
      const taken = await this.prisma.coachProfile.findUnique({
        where: { invite_code: candidate },
        select: { id: true },
      });
      if (!taken) return candidate;
    }
    throw new InternalServerErrorException('Could not allocate a coach invite code');
  }

  // Kill switch applied at every entry point: when SIGNUP_ROLE_CHOICE_ENABLED
  // is off, 'coach' degrades to the default (client) instead of erroring.
  private effectiveIntendedRole(intendedRole: IntendedRole | undefined): IntendedRole | undefined {
    if (!signupRoleChoiceEnabled()) return undefined;
    return intendedRole;
  }

  // Case-insensitive "does this address already have a row" lookup (Grok A1).
  // `User.email` is a case-sensitive unique index and legacy rows were stored
  // as typed, so an exact `findUnique` misses `Jane@Example.com` when Google
  // presents `jane@example.com`. Oldest row wins if legacy duplicates exist.
  private async findUserByEmailInsensitive(email: string) {
    return this.prisma.user.findFirst({
      where: { email: { equals: normalizeEmail(email), mode: 'insensitive' } },
      orderBy: { created_at: 'asc' },
    });
  }

  // Sol A-597-1 (fix round 4): registration NEVER deletes a Supabase
  // identity. Any delete issued after a failed local insert races every
  // other binder of the same identity — a retried registration, and the
  // Google/Apple create/link paths that Supabase auto-links by verified
  // email — and a database lock cannot fence an external delete that outlives
  // its transaction. So an identity whose local row could not be committed is
  // RETAINED and recovered without any destructive step:
  //   * unconfirmed: the next /auth/register for the address gets the same
  //     identity back from Supabase and binds it (same path as today);
  //   * confirmed (the user clicked the verification link first): the first
  //     successful password sign-in adopts it as a client
  //     (`adoptStrandedSignupIdentity`), exactly like Google/Apple first
  //     contact; Google/Apple sign-in for the address binds it too.
  // Logged by Supabase id only, for reconciliation.
  private logRetainedSignupIdentity(
    supabaseUserId: string,
    createdByThisRequest: boolean,
    reason: string,
  ) {
    this.logger.warn(
      `register: retained Supabase user ${supabaseUserId} without a local row after ${reason} ` +
        `(created_by_this_request=${createdByThisRequest}); recovered by retry, OAuth or first password sign-in`,
    );
  }

  // A-597-1 recovery for a CONFIRMED stranded identity. Only reached after
  // Supabase verified the password and no local row matches the verified id
  // or the canonical address. Only identities that carry the register marker
  // are adopted (a Supabase user created some other way still gets 401), and
  // always as a client with no coach: role choice and invite attach are not
  // replayed from user-editable metadata. A concurrent adopter/binder that
  // commits first wins (P2002 → re-read).
  private async adoptStrandedSignupIdentity(
    supaUser: { id?: unknown; email?: unknown; user_metadata?: unknown } | null | undefined,
    canonicalEmail: string,
    ctx: { ip?: string | null; userAgent?: string | null },
  ) {
    const supabaseUserId = typeof supaUser?.id === 'string' ? supaUser.id : '';
    const verifiedEmail = typeof supaUser?.email === 'string' ? normalizeEmail(supaUser.email) : '';
    if (
      !supabaseUserId ||
      verifiedEmail !== canonicalEmail ||
      !isServerMintedSignupMarker(signupAttemptMarker(supaUser), canonicalEmail)
    ) {
      return null;
    }
    const meta = supaUser?.user_metadata as Record<string, unknown> | undefined;
    const fullName = typeof meta?.full_name === 'string' ? meta.full_name.trim() : '';
    try {
      const created = await this.createSignupUser(
        {
          supabase_id: supabaseUserId,
          email: canonicalEmail,
          name: fullName || canonicalEmail.split('@')[0],
          phone: null,
          signup_ref: null,
        },
        undefined,
        'email',
        ctx,
      );
      this.logger.warn(`login: adopted stranded Supabase user ${supabaseUserId} as a client`);
      return this.prisma.user.findUnique({ where: { id: created.id }, include: { profile: true } });
    } catch (err) {
      if (!isSignupIdentityUniqueViolation(err)) throw err;
      return this.prisma.user.findUnique({
        where: { supabase_id: supabaseUserId },
        include: { profile: true },
      });
    }
  }

  // Grok B4: never create or link a local row for a Google identity whose
  // email Google/Supabase has not confirmed. An unverified address could
  // otherwise mint a coach (or link an email row) for an address the caller
  // does not control. Rows matched by supabase_id are unaffected.
  private googleEmailVerified(supaUser: {
    email_confirmed_at?: string | null;
    identities?: Array<{
      provider?: string;
      identity_data?: Record<string, unknown> | null;
    }> | null;
  }): boolean {
    if (supaUser.email_confirmed_at) return true;
    return (supaUser.identities ?? []).some(
      (i) => i.provider === 'google' && i.identity_data?.email_verified === true,
    );
  }

  // `invite_code` + `intended_role: 'coach'` is contradictory (a code attaches
  // the user to a coach AS A CLIENT). Refuse before any provider round-trip so
  // neither a Supabase user nor a local row is created for an ambiguous body.
  private assertRoleChoiceCompatibleWithInviteCode(
    intendedRole: IntendedRole | undefined,
    inviteCode: string | undefined,
  ) {
    if (intendedRole === 'coach' && inviteCode) {
      throw new BadRequestException({
        error: 'intended_role_not_allowed_with_invite_code',
        message:
          'An invite code enrols you as a client of that coach. Remove the invite code to create a coach account, or sign up as a client.',
      });
    }
  }

  async register(
    data: {
      email: string;
      password: string;
      name: string;
      phone?: string;
      ref?: string;
      intended_role?: IntendedRole;
    },
    ctx: AuditCtx = {},
  ) {
    // Validate password strength before sending to Supabase
    const { password } = data;
    if (
      password.length < 8 ||
      !/[A-Z]/.test(password) ||
      !/[0-9]/.test(password) ||
      !/[^A-Za-z0-9]/.test(password)
    ) {
      throw new BadRequestException(
        'Password must be at least 8 characters with one uppercase letter, one number, and one special character.',
      );
    }

    // Fix round (Grok A1 / Opus C2): one canonical address for the existence
    // check, the Supabase call and the stored value. Case-insensitive lookup
    // so a case variant of a known address is a duplicate, not a new coach.
    const email = normalizeEmail(data.email);
    const intendedRole = this.effectiveIntendedRole(data.intended_role);

    // Check if user already exists in our DB
    const existing = await this.findUserByEmailInsensitive(email);
    if (existing) throw new ConflictException('Email already registered');

    // Grok B3: allocate the coach invite code BEFORE the Supabase signUp so
    // the only post-signUp failure points are the DB write itself.
    const inviteCode =
      intendedRole === 'coach' ? await this.pickUnusedCoachInviteCode() : undefined;

    // Use Supabase native signup — this sends a real verification email automatically.
    // The redirect URL tells Supabase where to send the user after clicking the link.
    const supaClient = createClient(
      process.env.SUPABASE_URL || '',
      process.env.SUPABASE_ANON_KEY || '',
      { realtime: { transport: WS as any } },
    );

    // A-597-1: per-request ownership marker (see SIGNUP_ATTEMPT_METADATA_KEY).
    const signupAttempt = mintSignupAttemptMarker(email);
    const { data: signupData, error } = await supaClient.auth.signUp({
      email,
      password: data.password,
      options: {
        emailRedirectTo: `${process.env.SUPABASE_REDIRECT_URL || 'tgp://verified'}`,
        data: { full_name: data.name, [SIGNUP_ATTEMPT_METADATA_KEY]: signupAttempt },
      },
    });

    if (error) throw new BadRequestException(error.message);
    if (!signupData.user) throw new BadRequestException('Signup failed');
    // Supabase enumeration protection: an existing address comes back as a
    // placeholder user with `identities: []`. Same answer as our own check,
    // and no local row is ever bound to the placeholder id.
    if (isObfuscatedExistingSupabaseUser(signupData.user)) {
      throw new ConflictException('Email already registered');
    }

    // Create user record in our DB immediately. C13: role is fixed here from
    // `intended_role` (default client/student); it is never re-selectable later.
    const supabaseUserId = signupData.user.id;
    // A-597-1: did THIS request create the Supabase identity, or did Supabase
    // hand back an existing unconfirmed one (a concurrent or earlier signup)?
    // Nothing is ever deleted either way (fix round 4).
    const createdByThisRequest = signupAttemptMarker(signupData.user) === signupAttempt;
    if (!createdByThisRequest) {
      // Opus B-597-2: Supabase handed back an EXISTING unconfirmed identity
      // whose password it did not update. Bind it only if this caller proves
      // it knows that password; otherwise someone else (possibly an attacker
      // using the public anon signUp) set it, and binding would let them sign
      // in to this account once the owner confirms. Nothing is bound or
      // deleted on refusal.
      const proof = await supaClient.auth.signInWithPassword({ email, password: data.password });
      if (!isEmailNotConfirmedError(proof.error)) {
        this.logger.warn(
          `register: retained Supabase user ${supabaseUserId} not bound: caller did not prove its password`,
        );
        throw new ConflictException({
          code: 'signup_pending',
          message: 'Check your email to finish signing up, or reset your password.',
        });
      }
    }
    let user;
    try {
      user = await this.createSignupUser(
        {
          supabase_id: supabaseUserId,
          email,
          name: data.name,
          phone: data.phone || null,
          signup_ref: data.ref ?? null,
        },
        intendedRole,
        'email',
        ctx,
        { inviteCode },
      );
    } catch (err) {
      const reason = `local user create failed (${err instanceof Error ? err.constructor.name : 'error'})`;
      if (isSignupIdentityUniqueViolation(err)) {
        // A competing signup / OAuth binder for this address committed first
        // and owns the identity (and its fixed role). Answer like our own
        // duplicate check.
        this.logger.warn(
          `register: competing signup won for Supabase user ${supabaseUserId}; identity kept`,
        );
        throw new ConflictException('Email already registered');
      }
      // A-597-1: retain, never delete (see logRetainedSignupIdentity).
      this.logRetainedSignupIdentity(supabaseUserId, createdByThisRequest, reason);
      throw err;
    }

    // Psych Report #4: Analytics — user_registered server-side event
    this.analytics.capture(user.id, Events.USER_REGISTERED, {
      role: user.role,
      provider: 'email',
    });

    // Return pending status — mobile will show the verify email screen
    return {
      message: 'Verification email sent! Please check your inbox.',
      requires_verification: true,
      user_id: user.id,
      email,
      role: user.role,
    };
  }

  async login(
    email: string,
    password: string,
    ctx: { ip?: string | null; userAgent?: string | null } = {},
  ) {
    return this._passwordLogin(email, password, ctx, 'email_password');
  }

  // Extension login for the tgp-importer Chrome extension. Functionally
  // identical to `login` (proxies Supabase signInWithPassword and returns the
  // Supabase tokens verbatim) — it only differs in the audit-log source tag
  // (`source: 'extension'`) so ops can distinguish extension sessions from the
  // mobile/web app. It reuses Supabase sessions per the 2026-06-30 operator
  // ruling: no backend-minted tokens, no refresh-token table — Supabase owns
  // rotation + revocation. It shares `/auth/login`'s per-account failure lock
  // through `_passwordLogin` (C14 #604 Opus A1); per-IP counters are never
  // reset on either route.
  async extensionLogin(
    email: string,
    password: string,
    ctx: { ip?: string | null; userAgent?: string | null } = {},
  ) {
    return this._passwordLogin(email, password, ctx, 'extension');
  }

  // Shared email+password login against Supabase. `source` only affects the
  // audit-log metadata tag; the returned token/user shape is identical for
  // every caller. Extracted so `login` and `extensionLogin` cannot drift.
  //
  // C14 #604 Opus A1: the per-account failure lock lives HERE, not in the
  // controller, so every password endpoint (`/auth/login`,
  // `/auth/extension/login`) shares one lock and one failure counter per
  // account. `loginThrottle` is always wired in AuthModule (ThrottlerModule
  // exports it and AuthController requires the same provider non-optionally);
  // it is absent only in hand-built unit doubles.
  private async _passwordLogin(
    rawEmail: string,
    password: string,
    ctx: { ip?: string | null; userAgent?: string | null },
    source: 'email_password' | 'extension',
  ) {
    // B-597-1 (Sol): signup stores the canonical address (normalizeEmail), so
    // every sign-in path canonicalises the same way before any lookup. A user
    // who registered as `Jane@Example.com` signs in with that spelling, the
    // lowercase one, or any case variant.
    const email = normalizeEmail(rawEmail);
    // A1 (#604): the per-account lock keys on the same canonical address, so
    // case / Unicode variants of one account share one failure counter.
    const attempt = () => this._passwordLoginUnlocked(email, password, ctx, source);
    return this.loginThrottle ? this.loginThrottle.guardPasswordLogin(email, attempt) : attempt();
  }

  private async _passwordLoginUnlocked(
    email: string,
    password: string,
    ctx: { ip?: string | null; userAgent?: string | null },
    source: 'email_password' | 'extension',
  ) {
    // Authenticate via Supabase
    const supaClient = createClient(
      process.env.SUPABASE_URL || '',
      process.env.SUPABASE_ANON_KEY || '',
      { realtime: { transport: WS as any } },
    );

    const { data, error } = await supaClient.auth.signInWithPassword({ email, password });

    if (error) {
      // Surface specific errors so the mobile client can handle them
      const msg = error.message || '';

      // Audit the failure — best-effort, fire-and-forget. We look up the
      // user row to capture actor_id if the account exists (e.g. wrong
      // password scenario). We deliberately do NOT reveal in the thrown
      // error whether the email exists; the audit log is for ops only.
      // R30: the password is NEVER logged or audited — only a redacted reason.
      const failMetadata: Record<string, unknown> = { reason: 'invalid_credentials' };
      if (source === 'extension') failMetadata.source = 'extension';
      void this.prisma.user
        .findUnique({ where: { email }, select: { id: true, email: true } })
        .then((u) => u ?? this.findUserByEmailInsensitive(email))
        .then((u) => {
          const auditInput: AuditWriteInput = {
            action: AuditAction.AUTH_LOGIN_FAILED,
            actorId: u?.id ?? null,
            actorEmail: u?.email ?? email,
            ip: ctx.ip ?? null,
            userAgent: ctx.userAgent ?? null,
            // Redacted: reason only (never the password or full error message)
            metadata: failMetadata,
          };
          return this.audit.write(auditInput);
        })
        .catch(() => {
          // Swallow — audit failure must never affect the auth response.
        });

      if (msg.toLowerCase().includes('email') && msg.toLowerCase().includes('confirm')) {
        throw new UnauthorizedException(
          'Email not confirmed. Please check your inbox and verify your email first.',
        );
      }
      throw new UnauthorizedException('Invalid email or password');
    }

    // Find user in our DB. B-597-1: resolve by the VERIFIED Supabase user id
    // first (independent of the caller's spelling), then the canonical
    // address, then a case-insensitive match for legacy rows stored as typed.
    const verifiedSupabaseId = (data as { user?: { id?: unknown } | null }).user?.id;
    let user =
      typeof verifiedSupabaseId === 'string' && verifiedSupabaseId.length > 0
        ? await this.prisma.user.findUnique({
            where: { supabase_id: verifiedSupabaseId },
            include: { profile: true },
          })
        : null;
    if (!user) {
      user = await this.prisma.user.findUnique({
        where: { email },
        include: { profile: true },
      });
    }
    if (!user) {
      user = await this.prisma.user.findFirst({
        where: { email: { equals: email, mode: 'insensitive' } },
        orderBy: { created_at: 'asc' },
        include: { profile: true },
      });
    }
    if (!user) {
      // A-597-1 fix round 4: a confirmed identity stranded by a failed
      // registration is adopted here instead of being deleted at signup.
      user = await this.adoptStrandedSignupIdentity(
        (data as { user?: { id?: unknown; email?: unknown; user_metadata?: unknown } | null }).user,
        email,
        ctx,
      );
    }

    if (!user) throw new UnauthorizedException('User not found');

    // Audit successful login — fire-and-forget. `login` keeps its historical
    // `{ via: 'email_password' }` shape; extension logins add `source`.
    const metadata: Record<string, unknown> = { via: 'email_password' };
    if (source === 'extension') metadata.source = 'extension';
    void this.audit.write({
      action: AuditAction.AUTH_LOGIN,
      actorId: user.id,
      actorRole: user.role,
      actorEmail: user.email,
      targetUserId: user.id,
      targetType: 'user',
      targetId: user.id,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
      metadata,
    });

    // Return Supabase tokens + our user record
    return {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        coach_id: user.coach_id,
        profile: user.profile,
      },
    };
  }

  // Extension token refresh. Proxies Supabase refreshSession(refresh_token) and
  // returns the rotated pair verbatim. No backend-minted tokens and no
  // refresh-token table (2026-06-30 operator ruling): Supabase owns rotation +
  // revocation. On any Supabase error or missing session we surface a
  // structured 401 (R109: a real, actionable error — never a silent failure).
  async extensionRefresh(dto: { refresh_token: string }) {
    const { data, error } = await this.supabaseAdmin.auth.refreshSession({
      refresh_token: dto.refresh_token,
    });
    if (error || !data?.session) {
      // R30/R109: never log the refresh token; surface a clear, actionable code.
      this.logger.warn(`extension refresh rejected: ${error?.message ?? 'no session returned'}`);
      throw new UnauthorizedException({
        code: 'extension_refresh_invalid',
        message: 'refresh token invalid or expired',
      });
    }
    return {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_in: data.session.expires_in,
      expires_at: data.session.expires_at,
    };
  }

  // Mint an extension session for a coach BY IDENTITY — used by the v0.3
  // pairing-code redeem flow, which has no password to replay. Reuses the same
  // token authority as the rest of /auth/extension/*: a real Supabase session,
  // not a backend-minted token (R80). Supabase has no "session for a user id"
  // admin call, so we use the documented two-step server flow — generateLink
  // ({ type: 'magiclink' }) yields a single-use hashed OTP (no email is sent),
  // verifyOtp() exchanges it for a session. R30: never log the token.
  async mintExtensionSessionForCoach(
    coachUserId: string,
  ): Promise<{ access_token: string; refresh_token: string }> {
    const user = await this.prisma.user.findUnique({
      where: { id: coachUserId },
      select: { email: true, role: true, deleted_at: true },
    });
    // Re-validate the coach AT MINT TIME, not just at init (round-2 audit,
    // accepted): a coach demoted or deleted between init and redeem must not
    // receive a session. Role check reuses roleSatisfies — the same exported
    // predicate RolesGuard enforces on the init/status routes (owner > coach >
    // student hierarchy), so the mint gate can never drift from the route gate.
    // The rejection is the SAME generic `invalid` body redeem returns for an
    // unknown code — a distinct error would tell an unauthenticated holder of
    // a harvested code that the coach exists but was demoted/deleted (account-
    // state leak). All three predicates below are cheap in-memory checks on the
    // single fetched row, so no additional timing oracle is introduced beyond
    // the unavoidable DB lookup.
    if (!user || user.deleted_at || !roleSatisfies(user.role as AppRole, ['coach'])) {
      throw new BadRequestException({ code: 'invalid', message: 'Invalid pairing code.' });
    }

    const { data: linkData, error: linkError } = await this.supabaseAdmin.auth.admin.generateLink({
      type: 'magiclink',
      email: user.email,
    });
    const hashedToken = linkData?.properties?.hashed_token;
    if (linkError || !hashedToken) {
      this.logger.error(
        `pair redeem: generateLink failed: ${linkError?.message ?? 'no hashed_token'}`,
      );
      throw new InternalServerErrorException('pair_redeem_session_mint_failed');
    }

    // No realtime transport option here (unlike the long-lived admin client):
    // verifyOtp is a one-shot REST call and never opens a realtime socket, so
    // the ws WebSocket shim is unnecessary.
    const supaAnon = createClient(
      process.env.SUPABASE_URL || '',
      process.env.SUPABASE_ANON_KEY || '',
    );
    const { data: otpData, error: otpError } = await supaAnon.auth.verifyOtp({
      token_hash: hashedToken,
      type: 'email',
    });
    if (otpError || !otpData?.session) {
      this.logger.error(
        `pair redeem: verifyOtp failed: ${otpError?.message ?? 'no session returned'}`,
      );
      throw new InternalServerErrorException('pair_redeem_session_mint_failed');
    }
    return {
      access_token: otpData.session.access_token,
      refresh_token: otpData.session.refresh_token,
    };
  }

  // Returns the signup policy in effect for this build. Mobile calls this on
  // launch to decide whether to require the coach invite code field, which
  // auth providers to surface, and the format constraints for client-side
  // invite-code validation. Pure read of env flags + invite-code constants;
  // safe to call unauthenticated.
  //
  // Field guide for the mobile contract:
  //   - `invite_code_required`: canonical flag (matches `invite_code_field`).
  //     `coach_code_required` is preserved as a deprecated alias for older
  //     clients still on the pre-rename build.
  //   - `invite_code_field`: server-side body field name (`invite_code`).
  //   - `invite_code`: format spec the client uses to gate input before
  //     POST /auth/validate-invite-code (avoids the 32-char-overflow 400 the
  //     mobile invite QA surfaced in PR #61).
  //   - `providers`: ordered list of usable auth providers for this build.
  getSignupPolicy() {
    const gateEnabled = (process.env.COACH_CODE_GATE_ENABLED || '').toLowerCase() === 'true';
    // Base Supabase wiring is required for ANY OAuth provider to function —
    // the supabase admin client mints sessions from the verified provider
    // identity token. Without it, both Google and Apple paths return 401.
    const supabaseConfigured =
      !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
    // Audit #4 P1: Google is only advertised once a GOOGLE_CLIENT_ID(S) is
    // set. Without it, the local Google ID-token verifier (used by the
    // recent-auth re-auth flow) has no audience to pin against and every
    // attempt is rejected with a generic 401. Advertising "google" in the
    // policy on an unconfigured server gives mobile no way to know the
    // provider is unavailable until the user hits the failure mid-flow.
    const googleEnabled = supabaseConfigured && this.googleVerifier.isConfigured();
    // Apple is only advertised once an APPLE_AUDIENCES allow-list is set.
    // Without it the local defense-in-depth verifier has no audience to pin
    // the identity token to (see AppleVerifierService) and the route returns
    // 503; advertising it would just produce client errors at signup time.
    const appleEnabled = supabaseConfigured && this.appleVerifier.isConfigured();
    const providers = ['email'];
    if (googleEnabled) providers.push('google');
    if (appleEnabled) providers.push('apple');
    return {
      invite_code_required: gateEnabled,
      coach_code_required: gateEnabled,
      providers,
      // Clinic launch C02 — legacy field names the shipped mobile build reads
      // (CreateAccountScreen / RoleSelectionScreen): `require_invite_code`
      // mirrors invite_code_required; `google_signin_enabled` mirrors
      // providers.includes('google'). `apple_signin_enabled` is additive for
      // symmetry. Mobile falls back to require_invite_code=true and
      // google_signin_enabled=true when a field is missing, which is why the
      // omission was a live bug (codeless signup blocked; dead Google button).
      require_invite_code: gateEnabled,
      google_signin_enabled: googleEnabled,
      apple_signin_enabled: appleEnabled,
      invite_code_field: 'invite_code',
      invite_code: {
        min_length: INVITE_CODE_MIN_LENGTH,
        max_length: INVITE_CODE_MAX_LENGTH,
        prefix: INVITE_CODE_PREFIX,
      },
      // C13: mobile shows the client/coach picker on account creation and
      // sends `intended_role` on /auth/register, /auth/google, /auth/apple.
      // `false` when the SIGNUP_ROLE_CHOICE_ENABLED kill switch is off (the
      // field is still accepted and ignored, so no build ever gets a 400).
      role_choice: signupRoleChoiceEnabled(),
      role_choice_field: 'intended_role',
      role_choice_values: ['client', 'coach'],
    };
  }

  async googleAuth(
    token: string,
    inviteCode?: string,
    intendedRole?: IntendedRole,
    ctx: AuditCtx = {},
  ) {
    intendedRole = this.effectiveIntendedRole(intendedRole);
    this.assertRoleChoiceCompatibleWithInviteCode(intendedRole, inviteCode);
    // The mobile app uses Supabase OAuth flow (expo-auth-session).
    // The token here is a Supabase access_token from the OAuth redirect.
    // We use the admin SDK to look up the user by their access token.

    const { data: userData, error: userError } = await this.supabaseAdmin.auth.getUser(token);

    if (userError || !userData.user) {
      throw new UnauthorizedException('Google auth failed — invalid token');
    }

    const supaUser = userData.user;

    // SECURITY: make sure the token actually came from Google before trusting it to
    // perform an email-based account link (audit C9). Without this check, any valid
    // Supabase session token — including one issued via email/password login — could
    // be posted to /auth/google, and the server would happily link accounts by email.
    // The email/password login path does not call this method (see `login()` above),
    // so this does not affect that flow.
    const provider = supaUser.app_metadata?.provider;
    const providers: string[] = supaUser.app_metadata?.providers || [];
    const identityProviders: string[] = (supaUser.identities || [])
      .map((i) => i.provider)
      .filter(Boolean);
    const isGoogle =
      provider === 'google' || providers.includes('google') || identityProviders.includes('google');
    if (!isGoogle) {
      throw new UnauthorizedException('Google auth failed — token is not from Google');
    }

    // Supabase types email as optional — Google provider always returns one, but TS
    // doesn't know that. Bail out early under strict mode rather than trust the `!`.
    const supaEmail = supaUser.email ? normalizeEmail(supaUser.email) : undefined;
    if (!supaEmail) {
      throw new UnauthorizedException('Google account has no email');
    }

    // Upsert user in our DB (Google users are pre-verified)
    let user = await this.prisma.user.findUnique({ where: { supabase_id: supaUser.id } });
    let isNewUser = false;

    if (!user) {
      // Grok B4: creating or linking a row requires a confirmed address.
      if (!this.googleEmailVerified(supaUser)) {
        this.logger.warn(
          `googleAuth: refusing to create/link a row for an unverified Google email (supabase_id=${supaUser.id})`,
        );
        throw new UnauthorizedException('Google auth failed — email address is not verified');
      }
      // Also check by email in case user registered with email first
      // (case-insensitive, Grok A1).
      user = await this.findUserByEmailInsensitive(supaEmail);

      if (user) {
        // Account-takeover guard. Refuse to rebind a row whose supabase_id is
        // already set: an attacker could pre-register `victim@example.com`
        // through Supabase email/password without verifying, then come in
        // here via Google sign-in for the same address and silently inherit
        // the row (including any attached coach_id, billing, etc.). Only the
        // legacy "row created before Supabase linkage existed" case has
        // supabase_id === NULL, and that path is auditable on its own.
        // See QA P0-A1.
        if (user.supabase_id && user.supabase_id !== supaUser.id) {
          this.logger.warn(
            `googleAuth: refusing to re-bind supabase_id for existing user ${user.id} (email=${supaEmail}); supabase_id already set`,
          );
          throw new UnauthorizedException(
            'This email is registered with a different sign-in method. Sign in with that method, then link your Google account from settings.',
          );
        }
        // Link the Supabase ID to the existing email-based account
        user = await this.prisma.user.update({
          where: { id: user.id },
          data: { supabase_id: supaUser.id },
        });
      } else {
        // C13: brand-new row — the only branch where intended_role applies.
        // Grok B5: a new COACH consumes a per-IP slot that login success
        // never resets (client creates are not counted — clinic QR intake).
        if (intendedRole === 'coach') {
          await this.loginThrottle?.consumeOAuthCoachSignupSlot(ctx.throttleIp ?? ctx.ip);
        }
        user = await this.createSignupUser(
          {
            supabase_id: supaUser.id,
            email: supaEmail,
            name: supaUser.user_metadata?.full_name || supaEmail,
          },
          intendedRole,
          'google',
          ctx,
        );
        isNewUser = true;
        this.analytics.capture(user.id, Events.USER_REGISTERED_GOOGLE, {
          role: user.role,
          provider: 'google',
        });
      }
    }

    // If mobile passed an invite_code on the Google exchange, attach the
    // user to the coach in the same call. Failures are non-fatal — we still
    // log the user in so they can retry via /auth/attach-invite-code — but
    // the outcome is reported (C03). Same-coach re-attach is idempotent and a
    // different-coach code is refused inside attachUserToCoachByCode, so the
    // call is safe for returning users too.
    let invite_attached = false;
    let invite_attach_error: InviteAttachErrorCode | undefined;
    let invite_grant: AttachGrant | null | undefined;
    if (inviteCode && isCoachLikeRole(user.role)) {
      // Fix round (Opus B1 / Grok A2): a coach/owner signing in with a stale
      // QR / deep-link code is never demoted to a client. The service-level
      // guard in attachUserToCoachByCode throws `coach_cannot_redeem` too;
      // skipping here avoids even the attempt.
      this.logger.warn(
        `googleAuth: ignoring invite_code for user=${user.id} role=${user.role} (coach_cannot_redeem)`,
      );
      invite_attach_error = INVITE_ATTACH_ERROR.COACH_CANNOT_REDEEM;
    } else if (inviteCode) {
      const attach = await this.tryAttachInviteCode('googleAuth', user.id, inviteCode);
      invite_attached = attach.invite_attached;
      invite_attach_error = attach.invite_attach_error;
      invite_grant = attach.invite_grant;
      if (invite_attached) {
        const refreshed = await this.prisma.user.findUnique({ where: { id: user.id } });
        if (refreshed) user = refreshed;
      }
    }

    return {
      access_token: token,
      is_new_user: isNewUser,
      invite_attached,
      ...(invite_attach_error ? { invite_attach_error } : {}),
      ...(invite_grant ? { invite_grant } : {}),
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        coach_id: user.coach_id,
      },
    };
  }

  // Sign in with Apple. Mobile (#73) sends the identity token returned by
  // the iOS SDK; we exchange it for a Supabase session via
  // `signInWithIdToken({ provider: 'apple', token })` and upsert the local
  // user row. Apple returns the user's full_name only on the FIRST
  // authorization (and not in the identity token at all), so the mobile app
  // forwards it through here so we can persist it on first contact.
  async appleAuth(
    token: string,
    fullName?: string,
    inviteCode?: string,
    ctx: AuditCtx = {},
    raw_nonce?: string,
    intendedRole?: IntendedRole,
  ) {
    intendedRole = this.effectiveIntendedRole(intendedRole);
    this.assertRoleChoiceCompatibleWithInviteCode(intendedRole, inviteCode);
    if (!this.appleVerifier.isConfigured()) {
      // Feature-tier env var APPLE_AUDIENCES is not set on this deployment.
      // 503 (rather than a 401) so mobile can distinguish "not configured
      // yet — fall back to email or Google" from "your token is bad."
      throw new ServiceUnavailableException('Sign in with Apple is not configured on this server');
    }

    // Defense-in-depth: verify the identity token locally before handing it
    // to Supabase. Pins issuer (appleid.apple.com) + audience (our bundle
    // ids) so a token issued for an unrelated Apple client cannot reach the
    // upsert path. See AppleVerifierService.
    let applePayload;
    try {
      applePayload = await this.appleVerifier.verify(token);
    } catch (err) {
      this.logger.warn(`apple token verify failed: ${(err as Error).message}`);
      throw new UnauthorizedException('Apple auth failed — invalid token');
    }

    // Nonce binding: verify the raw nonce from the client matches the
    // SHA-256 nonce embedded in the Apple identity token.
    // Optional for now (migration period) — log missing nonces but don't
    // hard-block. Once all clients are updated, make this a hard throw.
    if (raw_nonce) {
      const expectedNonceHash = crypto.createHash('sha256').update(raw_nonce).digest('hex');
      const tokenNonce = applePayload.nonce as string | undefined;
      if (!tokenNonce) {
        throw new UnauthorizedException(
          'Apple auth failed — nonce provided by client but token contains no nonce claim',
        );
      } else if (tokenNonce !== expectedNonceHash) {
        throw new UnauthorizedException('Apple auth failed — nonce mismatch');
      }
    } else {
      if (process.env.APPLE_NONCE_REQUIRED === 'true') {
        throw new UnauthorizedException(
          'Apple auth failed — nonce is required but was not provided',
        );
      }
      // Log missing nonce to track client adoption. Set APPLE_NONCE_REQUIRED=true
      // in Fly once all mobile clients are updated to send raw_nonce.
      this.logger.warn(
        `appleAuth: no raw_nonce provided — token replay protection not active for this sign-in`,
      );
    }

    // Apple identity tokens always carry `sub`; `email` is included on first
    // authorization and on subsequent ones for users who have not chosen
    // "Hide My Email" + email-relay invalidation. We require email to upsert
    // a user row (Supabase will also reject without one).
    const appleEmail = typeof applePayload.email === 'string' ? applePayload.email : null;
    if (!appleEmail) {
      throw new UnauthorizedException('Apple account has no email');
    }

    // Hand the same token to Supabase to mint a session. Supabase verifies
    // the token a second time against Apple's JWKS, links it to the
    // `auth.identities` row keyed by Apple `sub`, and returns
    // access/refresh tokens we can pass back to the mobile client.
    const supaClient = createClient(
      process.env.SUPABASE_URL || '',
      process.env.SUPABASE_ANON_KEY || '',
      { realtime: { transport: WS as any } },
    );
    const { data: signInData, error: signInError } = await supaClient.auth.signInWithIdToken({
      provider: 'apple',
      token,
      ...(raw_nonce ? { nonce: raw_nonce } : {}),
    });

    if (signInError || !signInData.session || !signInData.user) {
      this.logger.warn(
        `supabase signInWithIdToken(apple) failed: ${signInError?.message ?? 'no session'}`,
      );
      throw new UnauthorizedException('Apple auth failed — Supabase rejected the token');
    }

    const supaUser = signInData.user;
    const supaEmail = normalizeEmail(supaUser.email || appleEmail);

    // Upsert user in our DB (Apple users are pre-verified by Apple itself).
    let user = await this.prisma.user.findUnique({
      where: { supabase_id: supaUser.id },
    });
    let isNewUser = false;

    if (!user) {
      // Also check by email in case the user registered via email or Google
      // first — link the Supabase ID onto the existing row instead of
      // creating a duplicate. Mirrors googleAuth's email-link fallback
      // (case-insensitive, Grok A1).
      user = await this.findUserByEmailInsensitive(supaEmail);

      if (user) {
        // Account-takeover guard — see googleAuth above for rationale.
        // QA P0-A1.
        if (user.supabase_id && user.supabase_id !== supaUser.id) {
          this.logger.warn(
            `appleAuth: refusing to re-bind supabase_id for existing user ${user.id} (email=${supaEmail}); supabase_id already set`,
          );
          throw new UnauthorizedException(
            'This email is registered with a different sign-in method. Sign in with that method, then link your Apple account from settings.',
          );
        }
        const dataToUpdate: { supabase_id: string; name?: string } = {
          supabase_id: supaUser.id,
        };
        // First-contact full_name persistence: if the local row was created
        // with a placeholder name (e.g. the email itself, from a stub
        // auto-link) and the Apple SDK gave us a real name, upgrade it now.
        // Subsequent logins (no full_name in body) leave the existing name
        // untouched.
        if (fullName && fullName.trim().length > 0 && (user.name === user.email || !user.name)) {
          dataToUpdate.name = fullName.trim();
        }
        user = await this.prisma.user.update({
          where: { id: user.id },
          data: dataToUpdate,
        });
      } else {
        const resolvedName =
          (fullName && fullName.trim().length > 0 && fullName.trim()) ||
          (typeof supaUser.user_metadata?.full_name === 'string' &&
            supaUser.user_metadata.full_name) ||
          supaEmail;
        // C13: brand-new row — the only branch where intended_role applies.
        // Grok B5: per-IP ceiling on OAuth-minted coaches (see googleAuth).
        if (intendedRole === 'coach') {
          await this.loginThrottle?.consumeOAuthCoachSignupSlot(ctx.throttleIp ?? ctx.ip);
        }
        user = await this.createSignupUser(
          {
            supabase_id: supaUser.id,
            email: supaEmail,
            name: resolvedName,
          },
          intendedRole,
          'apple',
          ctx,
        );
        isNewUser = true;
        this.analytics.capture(user.id, Events.USER_REGISTERED_APPLE, {
          role: user.role,
          provider: 'apple',
        });
      }
    } else if (fullName && fullName.trim().length > 0 && (user.name === user.email || !user.name)) {
      // Existing supabase-linked row with no real name yet — upgrade once.
      user = await this.prisma.user.update({
        where: { id: user.id },
        data: { name: fullName.trim() },
      });
    }

    // If mobile passed an invite_code on the Apple exchange, attach the
    // user to the coach in the same call. Failures are non-fatal — we still
    // log the user in so they can retry via /auth/attach-invite-code — but
    // the outcome is reported (C03); see googleAuth for the same contract.
    let invite_attached = false;
    let invite_attach_error: InviteAttachErrorCode | undefined;
    let invite_grant: AttachGrant | null | undefined;
    if (inviteCode && isCoachLikeRole(user.role)) {
      // Fix round (Opus B1 / Grok A2) — see googleAuth.
      this.logger.warn(
        `appleAuth: ignoring invite_code for user=${user.id} role=${user.role} (coach_cannot_redeem)`,
      );
      invite_attach_error = INVITE_ATTACH_ERROR.COACH_CANNOT_REDEEM;
    } else if (inviteCode) {
      const attach = await this.tryAttachInviteCode('appleAuth', user.id, inviteCode);
      invite_attached = attach.invite_attached;
      invite_attach_error = attach.invite_attach_error;
      invite_grant = attach.invite_grant;
      if (invite_attached) {
        const refreshed = await this.prisma.user.findUnique({
          where: { id: user.id },
        });
        if (refreshed) user = refreshed;
      }
    }

    // Audit Apple sign-in — fire-and-forget.
    void this.audit.write({
      action: AuditAction.AUTH_APPLE_SIGNIN,
      actorId: user.id,
      actorRole: user.role,
      actorEmail: user.email,
      targetUserId: user.id,
      targetType: 'user',
      targetId: user.id,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
      metadata: { is_new_user: isNewUser, invite_attached, invite_attach_error: invite_attach_error ?? null },
    });

    return {
      access_token: signInData.session.access_token,
      refresh_token: signInData.session.refresh_token,
      is_new_user: isNewUser,
      invite_attached,
      ...(invite_attach_error ? { invite_attach_error } : {}),
      ...(invite_grant ? { invite_grant } : {}),
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        coach_id: user.coach_id,
      },
    };
  }

  async selectRole(userId: string, role: 'coach' | 'student', inviteCode?: string) {
    // SECURITY: coach elevation via client-supplied code is disabled (audit C3).
    // The previous `CaboRules` backdoor allowed any authenticated user to escalate
    // to the `coach` role and read/write other users' data via other IDOR bugs.
    // Self-service role selection is restricted to `student`. Elevating a user to
    // `coach` must now happen out-of-band (direct SQL by an operator) until we
    // build a proper invite/admin flow. Contract is preserved (body still accepts
    // role + coach_code/invite_code); we just reject coach requests.
    if (role === 'coach') {
      throw new ForbiddenException('Coach accounts are provisioned manually. Contact support.');
    }

    // OWNERs cannot be coached. selectRole would otherwise silently demote
    // an OWNER to `student` (and, with an invite code, link them to a
    // coach's roster) — both outcomes are wrong. Refuse explicitly.
    const me = await this.prisma.user.findUnique({ where: { id: userId } });
    if (me?.role === 'owner') {
      throw new ForbiddenException('Owners cannot redeem a coach invite');
    }
    // Fix round (Opus B1 / Grok A2): a coach-like account can neither be
    // demoted to a client nor attached to another coach's roster here.
    // R-ROLE-CHOICE-1 — the role is fixed at creation; OWNER promote/demote
    // is the only path. Same structured code as attachUserToCoachByCode.
    if (isCoachLikeRole(me?.role)) {
      throw new ForbiddenException(coachCannotRedeemBody());
    }

    if (!me) {
      throw new NotFoundException('User not found');
    }

    // Sol SOL-C13-A1 — /auth/select-role is NOT a second invite writer.
    // Role is fixed at account creation (R-ROLE-CHOICE-1): every non-owner,
    // non-coach-like account is already `student`, so the codeless path is a
    // read-only acknowledgement and never rewrites `role`. With a code, the
    // request is delegated to the ONE canonical attach operation
    // (InviteCodesService.attachUserToCoachByCode), which refuses to
    // re-parent a client already attached to a different coach, checks the
    // intended recipient, the coach's subscription and seat capacity, and
    // writes coach_id only through a conditional (student, coach_id IS NULL)
    // update inside its transaction.
    if (!inviteCode) {
      if (me.role !== 'student') {
        // Defensive: unreachable for the roles that exist today (owner and
        // coach-like are refused above), but never silently rewrite a role.
        throw new ForbiddenException(coachCannotRedeemBody());
      }
      return { role: me.role };
    }

    const attached = await this.inviteCodes.attachUserToCoachByCode(userId, inviteCode);
    if (!attached.already_attached) {
      this.analytics.capture(userId, Events.INVITE_REDEEMED, {
        via: 'select_role',
        coach_id: attached.coach_id,
      });
    }
    return {
      role: attached.role,
      coach_id: attached.coach_id,
      ...(attached.grant ? { invite_grant: attached.grant } : {}),
    };
  }

  async getMe(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { profile: true },
    });

    if (!user) throw new UnauthorizedException('User not found');

    // Resolve subscription_tier for coaches (spec §4 / spec §5).
    // - null for non-coaches (students, owners with no sub row, etc.)
    // - CoachSubscription.tier for coaches; falls back to 'free' if no row
    //   (new coach who hasn't gone through becomeCoach yet, or coach pre-dating
    //    the billing system).
    // Access is scoped to req.user.id only — we never expose another coach's tier.
    let subscriptionTier: 'free' | 'pro' | 'enterprise' | null = null;
    if (user.role === 'coach') {
      // TODO(post-merge): Remove `as any` cast once `prisma generate` runs in CI
      // against the migrated schema and coachSubscription is typed with tier/status fields.
      const sub = await (this.prisma.coachSubscription.findUnique as any)({
        where: { coach_id: userId },
        select: { tier: true },
      });
      // Tier column added by migration 20260614000000_coach_subscription_tier.
      // Falls back to 'free' if row exists but tier is null (pre-migration row
      // not yet backfilled) or if no row exists at all.
      subscriptionTier = (sub?.tier as 'free' | 'pro' | 'enterprise' | undefined) ?? 'free';
    }

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      coach_id: user.coach_id,
      profile: user.profile,
      subscription_tier: subscriptionTier,
    };
  }

  async forgotPassword(email: string) {
    const supaClient = createClient(
      process.env.SUPABASE_URL || '',
      process.env.SUPABASE_ANON_KEY || '',
      { realtime: { transport: WS as any } },
    );

    // B-597-1: same canonical address as signup and sign-in.
    const { error } = await supaClient.auth.resetPasswordForEmail(normalizeEmail(email), {
      redirectTo: 'tgp://reset-password',
    });

    if (error) {
      // Don't reveal whether the email exists to the client — but do log so ops
      // can see Supabase outages instead of losing the signal. Audit M1.
      this.logger.warn(`resetPasswordForEmail failed: ${error.message}`);
    }

    return { message: 'If an account exists with that email, a reset link has been sent.' };
  }

  async validateSupabaseToken(supabaseId: string) {
    return this.prisma.user.findUnique({ where: { supabase_id: supabaseId } });
  }

  // Phase 1C: client signup that bundles the invite code in the same call.
  // Behind COACH_CODE_GATE_ENABLED=true the code is required (so a
  // platform-mode coach-gated rollout cannot be bypassed). Otherwise the
  // code is optional and the user signs up exactly like /auth/register.
  async signupWithCode(data: {
    email: string;
    password: string;
    name: string;
    phone?: string;
    invite_code?: string;
    ref?: string;
    intended_role?: IntendedRole;
  }) {
    const gateEnabled = (process.env.COACH_CODE_GATE_ENABLED || '').toLowerCase() === 'true';

    // C13: a code-based signup ALWAYS creates a client. Refuse 'coach'
    // up front (before Supabase signUp) with a stable error code so mobile
    // can route the user to the plain /auth/register coach path instead.
    // Grok C2: the code says WHY — with a code it is the contradiction, without
    // one it is the endpoint (this route never provisions coaches). Ignored
    // entirely when the kill switch is off (then 'coach' is a no-op client).
    if (this.effectiveIntendedRole(data.intended_role) === 'coach') {
      throw new BadRequestException(
        data.invite_code
          ? {
              error: 'intended_role_not_allowed_with_invite_code',
              message:
                'Signing up with an invite code always creates a client account. Use the standard signup without a code to create a coach account.',
            }
          : {
              error: 'coach_signup_requires_register_endpoint',
              message:
                'This endpoint only creates client accounts. Use POST /auth/register with intended_role=coach to create a coach account.',
            },
      );
    }

    if (gateEnabled && !data.invite_code) {
      throw new BadRequestException('Coach invite code is required');
    }
    if (data.invite_code) {
      const preview = await this.inviteCodes.previewCode(data.invite_code);
      if (!preview.valid) {
        throw new BadRequestException('Invalid or expired invite code');
      }
    }

    const registered = await this.register({
      email: data.email,
      password: data.password,
      name: data.name,
      phone: data.phone,
      ref: data.ref,
      // intended_role deliberately NOT forwarded: always a client here.
    });

    // C03: the code was previewed as valid above, but the attach can still
    // fail (seat race, coach paused between preview and attach, DB error).
    // The account exists either way; report the outcome instead of hiding it.
    let invite_attached = false;
    let invite_attach_error: InviteAttachErrorCode | undefined;
    let invite_grant: AttachGrant | null | undefined;
    if (data.invite_code) {
      const attach = await this.tryAttachInviteCode(
        'signupWithCode',
        registered.user_id,
        data.invite_code,
      );
      invite_attached = attach.invite_attached;
      invite_attach_error = attach.invite_attach_error;
      invite_grant = attach.invite_grant;
    }

    this.analytics.capture(registered.user_id, Events.USER_SIGNUP_WITH_CODE, {
      had_invite_code: !!data.invite_code,
      gate_enabled: gateEnabled,
      invite_attached,
      invite_attach_error: invite_attach_error ?? null,
    });

    return {
      ...registered,
      invite_attached,
      ...(invite_attach_error ? { invite_attach_error } : {}),
      ...(invite_grant ? { invite_grant } : {}),
    };
  }

  async becomeCoach(
    userId: string,
    password: string,
    ctx: { ip?: string | null; userAgent?: string | null } = {},
  ) {
    // Look up user so we have their email for Supabase re-auth
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('User not found');

    if (user.role === 'coach') {
      // Idempotent — already a coach; return current role and tier per spec §4.
      // Read the caller's own CoachSubscription row for the authoritative tier.
      // If no row exists (edge case: coach pre-dating the billing migration),
      // fall back to 'free' rather than throwing.
      // TODO(post-merge): Remove `as any` cast once `prisma generate` runs in CI
      // against the migrated schema and coachSubscription is typed with tier/status fields.
      const existingSub = await (this.prisma.coachSubscription.findUnique as any)({
        where: { coach_id: user.id },
        select: { tier: true },
      });
      return { role: user.role, tier: (existingSub?.tier ?? 'free') as string };
    }

    if (user.role === 'owner') {
      // OWNERs already pass through every coach gate; refuse the no-op
      // demotion-via-coach instead of silently overwriting role=owner.
      throw new ForbiddenException('Owners cannot self-elevate to coach.');
    }

    // SECURITY: self-service promotion is the canonical privilege-escalation
    // hole. Refuse unless an operator explicitly opts in via env var. The
    // structured shape lets the mobile client surface the right CTA
    // (contact your operator) without parsing free-text.
    if (!selfServiceBecomeCoachEnabled()) {
      throw new ForbiddenException({
        error: 'self_service_promotion_disabled',
        message:
          'Self-service promotion to coach is disabled on this deployment. An OWNER must promote you via the admin console.',
        canonical_path: '/admin/users/:id/promote',
      });
    }

    // Verify password against Supabase FIRST — a wrong-password caller must
    // never learn whether a CoachSubscription exists (that reveals billing
    // state). Only after the caller has proven they own the account do we
    // check the subscription gate.
    const supaClient = createClient(
      process.env.SUPABASE_URL || '',
      process.env.SUPABASE_ANON_KEY || '',
      { realtime: { transport: WS as any } },
    );
    const { error } = await supaClient.auth.signInWithPassword({
      email: user.email,
      password,
    });
    if (error) {
      throw new UnauthorizedException(
        'Password is incorrect. Provide your current password to become a coach.',
      );
    }

    // HYBRID PRICING: Replace old payment gate with a tier-aware upsert.
    //
    // OLD behaviour (removed): throw 403 coach_subscription_required unless
    // an active/trialing CoachSubscription row already existed. This blocked
    // all coaches who hadn't paid upfront.
    //
    // NEW behaviour (spec §7): upsert a CoachSubscription row with
    // tier='free' + status='active'. If a row already exists (e.g. an existing
    // Pro coach hitting this endpoint idempotently), update: {} leaves it
    // untouched — we never overwrite a higher tier.
    //
    // Stripe fields (stripe_customer_id, stripe_subscription_id) are NOT set
    // here. They are only ever set by the Stripe webhook handler (spec §9).
    //
    // TODO(pro-upgrade): when the Pro upgrade endpoint ships, implement:
    //   POST /billing/create-payment-intent
    //   Returns { clientSecret } for in-app Stripe Payment Sheet (mobile) /
    //   Elements (web). DO NOT use Stripe Checkout hosted pages —
    //   all checkout must stay in-app. See spec §14 (deferred to follow-up PR).
    // TODO(post-merge): Remove `as any` cast once `prisma generate` runs in CI
    // against the migrated schema and coachSubscription is typed with tier/status fields.
    const coachSub = await (this.prisma.coachSubscription.upsert as any)({
      where: { coach_id: userId },
      create: {
        coach_id: userId,
        tier: 'free',
        status: 'active',
        // All other fields use their schema defaults.
        // Do NOT set Stripe fields here — only the webhook sets those.
      },
      update: {},
      // update: {} is intentional. If a row already exists (e.g. an existing
      // Pro coach), we touch nothing — preserving their higher tier.
    });

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { role: 'coach' },
    });

    // Self-service elevations are reviewable: write the audit row with
    // actor = target so an operator can scan the audit log for any
    // surviving become-coach calls after the gate has been disabled.
    await this.audit.write({
      action: AuditAction.USER_ROLE_CHANGED,
      actorId: updated.id,
      actorRole: 'student',
      actorEmail: updated.email,
      targetUserId: updated.id,
      targetType: 'user',
      targetId: updated.id,
      tenantCoachId: updated.id,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
      metadata: { from: 'student', to: 'coach', via: 'self_service_become_coach' },
    });

    this.analytics.capture(updated.id, Events.COACH_PROMOTED, {
      via: 'become_coach',
      tier: coachSub.tier ?? 'free',
    });

    return { role: updated.role, tier: coachSub.tier ?? 'free' };
  }

  // First-gym bootstrap. Creates or promotes the very first owner-role user
  // on a fresh instance. Guarded by two preconditions that together prevent
  // post-launch privilege escalation:
  //   1. BOOTSTRAP_SECRET env var must be set on the server, and the caller
  //      must echo it back. After first use the operator should `fly secrets
  //      unset BOOTSTRAP_SECRET` to disarm the endpoint entirely.
  //   2. No active owner-role user may exist in the DB. Once any owner has
  //      been created (including via this endpoint), every subsequent call
  //      returns 403 even with the correct secret.
  async bootstrapFirstOwner(input: {
    email: string;
    password: string;
    name: string;
    bootstrapSecret: string;
  }): Promise<{
    access_token: string;
    user: { id: string; email: string; role: string };
  }> {
    const expectedSecret = process.env.BOOTSTRAP_SECRET;
    if (!expectedSecret) {
      throw new ForbiddenException('Bootstrap endpoint is not enabled on this instance.');
    }
    if (input.bootstrapSecret !== expectedSecret) {
      throw new ForbiddenException('Invalid bootstrap secret.');
    }

    // Only allow when no owner exists yet.
    const existingOwner = await this.prisma.user.findFirst({
      where: { role: 'owner', deleted_at: null, deletion_scheduled_at: null },
      select: { id: true },
    });
    if (existingOwner) {
      throw new ForbiddenException(
        'An owner already exists. Use the standard admin promotion flow.',
      );
    }

    // Register or find existing user.
    let user = await this.prisma.user.findUnique({
      where: { email: input.email },
    });

    if (!user) {
      // Create a confirmed Supabase user via the admin SDK — the operator
      // running bootstrap does not have an inbox waiting on a verification
      // email loop.
      const { data, error } = await this.supabaseAdmin.auth.admin.createUser({
        email: input.email,
        password: input.password,
        email_confirm: true,
      });
      if (error || !data?.user) {
        throw new BadRequestException(error?.message ?? 'Failed to create Supabase user.');
      }
      user = await this.prisma.user.upsert({
        where: { supabase_id: data.user.id },
        create: {
          supabase_id: data.user.id,
          email: input.email,
          name: input.name,
          role: 'owner',
        },
        update: { role: 'owner', name: input.name },
      });
    } else {
      user = await this.prisma.user.update({
        where: { id: user.id },
        data: { role: 'owner' },
      });
    }

    // Sign in to mint a JWT for the new owner.
    const supaClient = createClient(
      process.env.SUPABASE_URL || '',
      process.env.SUPABASE_ANON_KEY || '',
      { realtime: { transport: WS as any } },
    );
    const { data: signInData, error: signInError } = await supaClient.auth.signInWithPassword({
      email: input.email,
      password: input.password,
    });
    if (signInError || !signInData?.session?.access_token) {
      throw new UnauthorizedException(
        'Created owner but could not sign in: ' + (signInError?.message ?? 'unknown'),
      );
    }

    this.logger.warn(
      `bootstrapFirstOwner: promoted ${user.email} (id=${user.id}) to owner. Unset BOOTSTRAP_SECRET now.`,
    );

    return {
      access_token: signInData.session.access_token,
      user: { id: user.id, email: user.email, role: user.role },
    };
  }

  /**
   * Issue a recent-auth token for the authenticated user.
   *
   * The token is a short-lived HMAC proof that the user just re-entered their
   * password (or passed biometric auth). It must be passed as the
   * `X-Recent-Auth-Token` header on sensitive endpoints guarded by
   * `RecentAuthGuard`.
   *
   * ## Why verify the password here?
   *
   * The mobile client calls this endpoint with the user's current password.
   * We verify against Supabase before issuing the token — this ensures the
   * "recent auth" proof is tied to actual credential knowledge, not just a
   * valid session cookie.
   *
   * ## Token lifetime
   *
   * Configured by `RECENT_AUTH_TTL_MS` (default 5 min). The token is
   * stateless — no server-side storage — so revocation requires waiting
   * out the TTL. The short window limits blast radius.
   */
  async issueRecentAuthToken(
    userId: string,
    body: {
      password?: string;
      provider_token?: string;
      provider?: 'google' | 'apple' | 'google_session';
    },
  ): Promise<{ token: string; expires_in_ms: number }> {
    const secret = process.env.RECENT_AUTH_SECRET;
    if (!secret || secret.length < RECENT_AUTH_SECRET_MIN_LENGTH) {
      // Misconfiguration is internal — never leak the env-var name to the client
      // (R17). Log the real reason server-side and return a generic 500-class
      // message so the mobile app can show "try again later" rather than
      // surfacing a secret name.
      this.logger.error(
        `RECENT_AUTH_SECRET is not configured or shorter than ${RECENT_AUTH_SECRET_MIN_LENGTH} characters — recent-auth token issue blocked`,
      );
      throw new InternalServerErrorException('Sensitive action temporarily unavailable');
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('User not found');

    // Re-auth proof: one of
    //   (a) password  — for email/password users (Supabase signInWithPassword), OR
    //   (b) provider_token + provider — for OAuth-only users (Google/Apple) who
    //       have no password on file. We re-verify the fresh provider identity
    //       token and require it to have been issued within RECENT_AUTH_TTL_MS.
    // Without (b), OAuth-only users would be permanently locked out of
    // account deletion (GDPR/compliance regression).
    if (body.provider_token && body.provider) {
      await this.verifyOAuthRecentAuthProof(user, body.provider, body.provider_token);
    } else if (body.password) {
      const supaClient = createClient(
        process.env.SUPABASE_URL || '',
        process.env.SUPABASE_ANON_KEY || '',
        { realtime: { transport: WS as any } },
      );
      let result;
      try {
        result = await this.withAuthTimeout(
          supaClient.auth.signInWithPassword({
            email: user.email,
            password: body.password,
          }),
          'signInWithPassword',
        );
      } catch (err) {
        const m = (err as Error)?.message ?? '';
        if (m.startsWith('AUTH_TIMEOUT:')) {
          this.logger.warn(`recent-auth supabase timeout: ${m}`);
          throw new ServiceUnavailableException('Authentication service temporarily unavailable');
        }
        throw err;
      }
      if (result.error) {
        throw new UnauthorizedException('Password is incorrect');
      }
    } else {
      throw new BadRequestException('Provide either password or provider_token + provider');
    }

    const token = issueRecentAuthToken(userId, secret);
    const ttl = parseTtlMs(process.env.RECENT_AUTH_TTL_MS) ?? RECENT_AUTH_TTL_DEFAULT_MS;

    return { token, expires_in_ms: ttl };
  }

  /**
   * Google re-auth through the Supabase-brokered OAuth flow (mobile #313
   * B-313-1). The mobile build ships no Google client id (auth is
   * Supabase-brokered), so it cannot obtain a Google-issued ID token. It
   * instead runs the same Supabase Google OAuth browser flow again and sends
   * the access token of that brand-new session. Proof requirements:
   *   1. Supabase accepts the token (getUser validates it server-side);
   *   2. it belongs to this user (sub == supabase_id) and the identity has a
   *      google provider;
   *   3. its `amr` claim records an `oauth` authentication within
   *      RECENT_AUTH_TTL_MS. Supabase keeps the original amr timestamp across
   *      refreshes, so the app's existing session token (the replay the old
   *      getUser-only path allowed) does not qualify unless the user really
   *      signed in with Google moments ago.
   */
  private async verifyGoogleSessionRecentAuth(
    user: { id: string; email: string; supabase_id: string | null },
    sessionToken: string,
    nowSec: number,
    ttlSec: number,
  ): Promise<void> {
    const claims = decodeJwtClaims(sessionToken);
    if (!claims) throw new UnauthorizedException('Provider token is invalid');
    let supaUser: { id: string; app_metadata?: Record<string, unknown> } | null = null;
    try {
      const resp = await this.withAuthTimeout<{
        data: { user: { id: string; app_metadata?: Record<string, unknown> } | null };
        error: { message: string } | null;
      }>(this.supabaseAdmin.auth.getUser(sessionToken), 'getUser');
      supaUser = resp.error ? null : resp.data.user;
    } catch (err) {
      const m = (err as Error)?.message ?? '';
      if (m.startsWith('AUTH_TIMEOUT:')) {
        this.logger.warn(`recent-auth supabase timeout: ${m}`);
        throw new ServiceUnavailableException('Authentication service temporarily unavailable');
      }
      throw new UnauthorizedException('Provider token is invalid');
    }
    if (!supaUser || claims.sub !== supaUser.id) {
      throw new UnauthorizedException('Provider token is invalid');
    }
    if (!user.supabase_id || supaUser.id !== user.supabase_id) {
      throw new UnauthorizedException('Provider token does not belong to this user');
    }
    const providers = supaUser.app_metadata?.['providers'];
    const hasGoogle =
      (Array.isArray(providers) && providers.includes('google')) ||
      supaUser.app_metadata?.['provider'] === 'google';
    if (!hasGoogle) {
      throw new UnauthorizedException('Provider token is invalid');
    }
    const amr: unknown = Reflect.get(claims, 'amr');
    const oauthAt = Array.isArray(amr)
      ? amr
          .map((entry: unknown) =>
            typeof entry === 'object' && entry !== null && Reflect.get(entry, 'method') === 'oauth'
              ? Reflect.get(entry, 'timestamp')
              : null,
          )
          .filter((t): t is number => typeof t === 'number')
      : [];
    const freshest = oauthAt.length > 0 ? Math.max(...oauthAt) : null;
    if (freshest === null || nowSec - freshest > ttlSec) {
      throw new UnauthorizedException(
        'Provider token is stale — request a fresh provider token and retry',
      );
    }
  }

  /**
   * Re-verify a fresh Google/Apple identity token as a proof of recent auth.
   *
   * For OAuth-only users (no password on file) this is the only way to obtain
   * a recent-auth token for sensitive actions. We require the provider token
   * to have been issued within RECENT_AUTH_TTL_MS (default 5 minutes) — i.e.
   * the mobile client must mint a fresh provider token immediately before
   * calling this endpoint, exactly the same freshness guarantee a password
   * re-prompt provides.
   *
   * Throws UnauthorizedException on any failure (invalid token, wrong issuer
   * / audience, expired, stale, not bound to this user). Never leaks the
   * underlying reason to the client beyond "expired" vs "invalid".
   */
  private async verifyOAuthRecentAuthProof(
    user: { id: string; email: string; supabase_id: string | null },
    provider: 'google' | 'apple' | 'google_session',
    providerToken: string,
  ): Promise<void> {
    const ttl = parseTtlMs(process.env.RECENT_AUTH_TTL_MS) ?? RECENT_AUTH_TTL_DEFAULT_MS;
    const nowSec = Math.floor(Date.now() / 1000);
    const ttlSec = Math.ceil(ttl / 1000);

    if (provider === 'google_session') {
      await this.verifyGoogleSessionRecentAuth(user, providerToken, nowSec, ttlSec);
      return;
    }

    if (provider === 'apple') {
      // Apple — defense-in-depth verify the JWT with our pinned audience list,
      // then check iat freshness.
      let payload;
      try {
        payload = await this.appleVerifier.verify(providerToken);
      } catch (err) {
        this.logger.warn(
          `recent-auth apple token verify failed for user=${user.id}: ${(err as Error).message}`,
        );
        throw new UnauthorizedException('Provider token is invalid');
      }
      const iat = typeof payload.iat === 'number' ? payload.iat : null;
      if (iat === null) {
        throw new UnauthorizedException('Provider token missing iat');
      }
      if (nowSec - iat > ttlSec) {
        throw new UnauthorizedException(
          'Provider token is stale — request a fresh provider token and retry',
        );
      }
      const email = typeof payload.email === 'string' ? payload.email : null;
      // Bind the token to *this* user. Apple `sub` is the stable identifier;
      // we fall back to email match if the Supabase user row stores the email
      // path. This prevents an Apple token from a different account being
      // used to issue a recent-auth token for the caller.
      const supaClient = createClient(
        process.env.SUPABASE_URL || '',
        process.env.SUPABASE_ANON_KEY || '',
        { realtime: { transport: WS as any } },
      );
      let signInData;
      let signInError;
      try {
        const resp = await this.withAuthTimeout(
          supaClient.auth.signInWithIdToken({ provider: 'apple', token: providerToken }),
          'signInWithIdToken',
        );
        signInData = resp.data;
        signInError = resp.error;
      } catch (err) {
        const m = (err as Error)?.message ?? '';
        if (m.startsWith('AUTH_TIMEOUT:')) {
          this.logger.warn(`recent-auth supabase timeout: ${m}`);
          throw new ServiceUnavailableException('Authentication service temporarily unavailable');
        }
        throw err;
      }
      if (signInError || !signInData?.user) {
        this.logger.warn(
          `recent-auth apple supabase verify failed for user=${user.id}: ${signInError?.message ?? 'no session'}`,
        );
        throw new UnauthorizedException('Provider token is invalid');
      }
      const supaUserId = signInData.user.id;
      const supaEmail = signInData.user.email ?? null;
      const matchesByEmail =
        !!email && !!supaEmail && supaEmail.toLowerCase() === user.email.toLowerCase();
      const matchesBySupabaseId = !!user.supabase_id && user.supabase_id === supaUserId;
      if (!matchesByEmail && !matchesBySupabaseId) {
        throw new UnauthorizedException('Provider token does not belong to this user');
      }
      return;
    }

    // Google — `providerToken` MUST be a Google-issued ID token (NOT a
    // Supabase access token). We verify it against Google's JWKS, pin the
    // audience to our GOOGLE_CLIENT_ID(s), require a recent `iat`, and bind
    // the verified Google identity (sub / email) to the authenticated user.
    //
    // History: an earlier version of this branch passed `providerToken` to
    // `supabaseAdmin.auth.getUser()`, which transparently accepts a Supabase
    // session JWT. Because the caller already authenticates the request with
    // exactly such a token via the Authorization header, that allowed the
    // current session token to double as "proof of fresh Google re-auth" —
    // no real Google interaction required. This new path closes that gap.
    if (!this.googleVerifier.isConfigured()) {
      this.logger.error(
        'GOOGLE_CLIENT_ID(S) not configured — recent-auth google branch unavailable',
      );
      throw new UnauthorizedException('Provider token is invalid');
    }
    let payload;
    try {
      payload = await this.googleVerifier.verify(providerToken);
    } catch (err) {
      this.logger.warn(
        `recent-auth google token verify failed for user=${user.id}: ${(err as Error).message}`,
      );
      throw new UnauthorizedException('Provider token is invalid');
    }
    const iat = typeof payload.iat === 'number' ? payload.iat : null;
    if (iat === null) {
      throw new UnauthorizedException('Provider token missing iat');
    }
    if (nowSec - iat > ttlSec) {
      throw new UnauthorizedException(
        'Provider token is stale — request a fresh provider token and retry',
      );
    }
    // Bind to this user. Google `sub` is the stable identifier we record on
    // the Supabase identity row; email is checked as a fallback (and is the
    // common path for legacy users who signed in before sub-binding shipped).
    const googleSub = typeof payload.sub === 'string' ? payload.sub : null;
    const googleEmail = typeof payload.email === 'string' ? payload.email : null;
    const emailVerified = payload.email_verified === true;
    const matchesByEmail =
      emailVerified && !!googleEmail && googleEmail.toLowerCase() === user.email.toLowerCase();
    // Look up the Supabase user's Google identity `sub` to support binding
    // by stable id (preferred — survives the user changing their Google
    // primary email).
    let matchesBySub = false;
    if (googleSub && user.supabase_id) {
      try {
        const { data: supaData } = await this.withAuthTimeout<any>(
          this.supabaseAdmin.auth.admin.getUserById(user.supabase_id),
          'getUserById',
        );
        const supaIdentities = supaData?.user?.identities || [];
        for (const identity of supaIdentities) {
          if (
            identity.provider === 'google' &&
            ((identity.identity_data as { sub?: string } | undefined)?.sub === googleSub ||
              identity.id === googleSub)
          ) {
            matchesBySub = true;
            break;
          }
        }
      } catch (err) {
        const m = (err as Error)?.message ?? '';
        if (m.startsWith('AUTH_TIMEOUT:')) {
          this.logger.warn(`recent-auth supabase timeout: ${m}`);
          throw new ServiceUnavailableException('Authentication service temporarily unavailable');
        }
        this.logger.warn(
          `recent-auth google sub lookup failed for user=${user.id}: ${(err as Error).message}`,
        );
      }
    }
    if (!matchesByEmail && !matchesBySub) {
      throw new UnauthorizedException('Provider token does not belong to this user');
    }
  }
}

/**
 * Unverified JWT claims (base64url payload). Only used after/alongside a
 * server-side validation of the same token (Supabase getUser), never alone.
 */
function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed))
      : null;
  } catch {
    return null;
  }
}
