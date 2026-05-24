import * as crypto from 'crypto';
import {
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createClient } from '@supabase/supabase-js';
// Named import (not `import ws from 'ws'`) — see supabase.service.ts for why.
import { WebSocket as WS } from 'ws';
import { PrismaService } from '../prisma.service';
import {
  InviteCodesService,
  INVITE_CODE_MAX_LENGTH,
  INVITE_CODE_MIN_LENGTH,
  INVITE_CODE_PREFIX,
} from '../invite-codes/invite-codes.service';
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

// Self-service promotion to coach is the legacy behavior of POST
// /auth/become-coach. It is a privilege-escalation hole on a sale-ready
// enterprise tenant — any client with their password could become a coach.
// The endpoint is hard-gated off by default. To re-enable for legacy
// migrations, set ALLOW_SELF_SERVICE_BECOME_COACH=true; the canonical
// path remains OWNER-only POST /admin/users/:id/promote.
function selfServiceBecomeCoachEnabled(): boolean {
  return (process.env.ALLOW_SELF_SERVICE_BECOME_COACH ?? '').toLowerCase() === 'true';
}

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
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); },
      );
    });
  }

  async register(data: { email: string; password: string; name: string; phone?: string }) {
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

    // Check if user already exists in our DB
    const existing = await this.prisma.user.findUnique({ where: { email: data.email } });
    if (existing) throw new ConflictException('Email already registered');

    // Use Supabase native signup — this sends a real verification email automatically.
    // The redirect URL tells Supabase where to send the user after clicking the link.
    const supaClient = createClient(
      process.env.SUPABASE_URL || '',
      process.env.SUPABASE_ANON_KEY || '',
      { realtime: { transport: WS as any } },
    );

    const { data: signupData, error } = await supaClient.auth.signUp({
      email: data.email,
      password: data.password,
      options: {
        emailRedirectTo: `${process.env.SUPABASE_REDIRECT_URL || 'tgp://verified'}`,
        data: { full_name: data.name },
      },
    });

    if (error) throw new BadRequestException(error.message);
    if (!signupData.user) throw new BadRequestException('Signup failed');

    // Create user record in our DB immediately (role selection happens after verify)
    const user = await this.prisma.user.create({
      data: {
        supabase_id: signupData.user.id,
        email: data.email,
        name: data.name,
        phone: data.phone || null,
        role: 'student',
      },
    });

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
      email: data.email,
    };
  }

  async login(
    email: string,
    password: string,
    ctx: { ip?: string | null; userAgent?: string | null } = {},
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
      void this.prisma.user
        .findUnique({ where: { email }, select: { id: true, email: true } })
        .then((u) => {
          const auditInput: AuditWriteInput = {
            action: AuditAction.AUTH_LOGIN_FAILED,
            actorId: u?.id ?? null,
            actorEmail: u?.email ?? email,
            ip: ctx.ip ?? null,
            userAgent: ctx.userAgent ?? null,
            // Redacted: reason only (never the password or full error message)
            metadata: { reason: 'invalid_credentials' },
          };
          return this.audit.write(auditInput);
        })
        .catch(() => {
          // Swallow — audit failure must never affect the auth response.
        });

      if (msg.toLowerCase().includes('email') && msg.toLowerCase().includes('confirm')) {
        throw new UnauthorizedException('Email not confirmed. Please check your inbox and verify your email first.');
      }
      throw new UnauthorizedException('Invalid email or password');
    }

    // Find user in our DB
    const user = await this.prisma.user.findUnique({
      where: { email },
      include: { profile: true },
    });

    if (!user) throw new UnauthorizedException('User not found');

    // Audit successful login — fire-and-forget.
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
      metadata: { via: 'email_password' },
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
    const gateEnabled =
      (process.env.COACH_CODE_GATE_ENABLED || '').toLowerCase() === 'true';
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
    const googleEnabled =
      supabaseConfigured && this.googleVerifier.isConfigured();
    // Apple is only advertised once an APPLE_AUDIENCES allow-list is set.
    // Without it the local defense-in-depth verifier has no audience to pin
    // the identity token to (see AppleVerifierService) and the route returns
    // 503; advertising it would just produce client errors at signup time.
    const appleEnabled =
      supabaseConfigured && this.appleVerifier.isConfigured();
    const providers = ['email'];
    if (googleEnabled) providers.push('google');
    if (appleEnabled) providers.push('apple');
    return {
      invite_code_required: gateEnabled,
      coach_code_required: gateEnabled,
      providers,
      invite_code_field: 'invite_code',
      invite_code: {
        min_length: INVITE_CODE_MIN_LENGTH,
        max_length: INVITE_CODE_MAX_LENGTH,
        prefix: INVITE_CODE_PREFIX,
      },
    };
  }

  async googleAuth(token: string, inviteCode?: string) {
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
    const identityProviders: string[] =
      (supaUser.identities || []).map((i) => i.provider).filter(Boolean);
    const isGoogle =
      provider === 'google' ||
      providers.includes('google') ||
      identityProviders.includes('google');
    if (!isGoogle) {
      throw new UnauthorizedException('Google auth failed — token is not from Google');
    }

    // Supabase types email as optional — Google provider always returns one, but TS
    // doesn't know that. Bail out early under strict mode rather than trust the `!`.
    const supaEmail = supaUser.email;
    if (!supaEmail) {
      throw new UnauthorizedException('Google account has no email');
    }

    // Upsert user in our DB (Google users are pre-verified)
    let user = await this.prisma.user.findUnique({ where: { supabase_id: supaUser.id } });
    let isNewUser = false;

    if (!user) {
      // Also check by email in case user registered with email first
      user = await this.prisma.user.findUnique({ where: { email: supaEmail } });

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
        user = await this.prisma.user.create({
          data: {
            supabase_id: supaUser.id,
            email: supaEmail,
            name: supaUser.user_metadata?.full_name || supaEmail,
            role: 'student',
          },
        });
        isNewUser = true;
        this.analytics.capture(user.id, Events.USER_REGISTERED_GOOGLE, {
          role: user.role,
          provider: 'google',
        });
      }
    }

    // If mobile passed an invite_code on the Google exchange, attach the
    // user to the coach in the same call. Failures are non-fatal — we still
    // log the user in so they can retry via /auth/attach-invite-code.
    let invite_attached = false;
    if (inviteCode && !user.coach_id) {
      try {
        await this.inviteCodes.attachUserToCoachByCode(user.id, inviteCode);
        const refreshed = await this.prisma.user.findUnique({ where: { id: user.id } });
        if (refreshed) user = refreshed;
        invite_attached = true;
      } catch (err) {
        this.logger.warn(
          `googleAuth invite_code attach failed for user=${user.id}: ${(err as Error).message}`,
        );
      }
    }

    return {
      access_token: token,
      is_new_user: isNewUser,
      invite_attached,
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
    ctx: { ip?: string | null; userAgent?: string | null } = {},
    raw_nonce?: string,
  ) {
    if (!this.appleVerifier.isConfigured()) {
      // Feature-tier env var APPLE_AUDIENCES is not set on this deployment.
      // 503 (rather than a 401) so mobile can distinguish "not configured
      // yet — fall back to email or Google" from "your token is bad."
      throw new ServiceUnavailableException(
        'Sign in with Apple is not configured on this server',
      );
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
      const expectedNonceHash = crypto
        .createHash('sha256')
        .update(raw_nonce)
        .digest('hex');
      const tokenNonce = applePayload.nonce as string | undefined;
      if (!tokenNonce) {
        throw new UnauthorizedException(
          'Apple auth failed — nonce provided by client but token contains no nonce claim',
        );
      } else if (tokenNonce !== expectedNonceHash) {
        throw new UnauthorizedException(
          'Apple auth failed — nonce mismatch',
        );
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
    const appleEmail =
      typeof applePayload.email === 'string' ? applePayload.email : null;
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
    const { data: signInData, error: signInError } =
      await supaClient.auth.signInWithIdToken({
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
    const supaEmail = supaUser.email || appleEmail;

    // Upsert user in our DB (Apple users are pre-verified by Apple itself).
    let user = await this.prisma.user.findUnique({
      where: { supabase_id: supaUser.id },
    });
    let isNewUser = false;

    if (!user) {
      // Also check by email in case the user registered via email or Google
      // first — link the Supabase ID onto the existing row instead of
      // creating a duplicate. Mirrors googleAuth's email-link fallback.
      user = await this.prisma.user.findUnique({ where: { email: supaEmail } });

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
        if (
          fullName &&
          fullName.trim().length > 0 &&
          (user.name === user.email || !user.name)
        ) {
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
        user = await this.prisma.user.create({
          data: {
            supabase_id: supaUser.id,
            email: supaEmail,
            name: resolvedName,
            role: 'student',
          },
        });
        isNewUser = true;
        this.analytics.capture(user.id, Events.USER_REGISTERED_APPLE, {
          role: user.role,
          provider: 'apple',
        });
      }
    } else if (
      fullName &&
      fullName.trim().length > 0 &&
      (user.name === user.email || !user.name)
    ) {
      // Existing supabase-linked row with no real name yet — upgrade once.
      user = await this.prisma.user.update({
        where: { id: user.id },
        data: { name: fullName.trim() },
      });
    }

    // If mobile passed an invite_code on the Apple exchange, attach the
    // user to the coach in the same call. Failures are non-fatal — we still
    // log the user in so they can retry via /auth/attach-invite-code.
    let invite_attached = false;
    if (inviteCode && !user.coach_id) {
      try {
        await this.inviteCodes.attachUserToCoachByCode(user.id, inviteCode);
        const refreshed = await this.prisma.user.findUnique({
          where: { id: user.id },
        });
        if (refreshed) user = refreshed;
        invite_attached = true;
      } catch (err) {
        this.logger.warn(
          `appleAuth invite_code attach failed for user=${user.id}: ${(err as Error).message}`,
        );
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
      metadata: { is_new_user: isNewUser, invite_attached },
    });

    return {
      access_token: signInData.session.access_token,
      refresh_token: signInData.session.refresh_token,
      is_new_user: isNewUser,
      invite_attached,
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
      throw new ForbiddenException(
        'Coach accounts are provisioned manually. Contact support.',
      );
    }

    // OWNERs cannot be coached. selectRole would otherwise silently demote
    // an OWNER to `student` (and, with an invite code, link them to a
    // coach's roster) — both outcomes are wrong. Refuse explicitly.
    const me = await this.prisma.user.findUnique({ where: { id: userId } });
    if (me?.role === 'owner') {
      throw new ForbiddenException('Owners cannot redeem a coach invite');
    }

    // No invite code — preserve the pre-invite-code behavior exactly: student
    // role, no coach linkage. Existing clients that never sent a code keep
    // working unchanged.
    if (!inviteCode) {
      const user = await this.prisma.user.update({
        where: { id: userId },
        data: { role },
      });
      return { role: user.role };
    }

    // Invite-code path: validate, then atomically link the student to the
    // coach and bump used_count. Run both writes in an interactive transaction
    // and re-check the guard (revoked, expires_at, max_uses) inside so two
    // concurrent redemptions can't slip through on the last seat.
    const validation = await this.inviteCodes.validate(inviteCode);
    if (!validation.valid) {
      throw new BadRequestException('Invalid or expired invite code');
    }

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        // updateMany is the guarded increment. `max_uses: null` means unlimited;
        // otherwise we bump only if the row's used_count is still below its
        // own max_uses. Prisma doesn't support column-to-column comparison in
        // updateMany, so we fetch the current row first and include its
        // used_count as a lower bound — effectively optimistic concurrency.
        const current = await tx.inviteCode.findUnique({
          where: { id: validation.invite_code_id },
        });
        if (!current || current.revoked) {
          throw new BadRequestException('Invalid or expired invite code');
        }
        if (current.expires_at && current.expires_at.getTime() <= Date.now()) {
          throw new BadRequestException('Invalid or expired invite code');
        }
        if (current.max_uses !== null && current.used_count >= current.max_uses) {
          throw new BadRequestException('Invalid or expired invite code');
        }

        const updated = await tx.inviteCode.updateMany({
          where: {
            id: validation.invite_code_id,
            revoked: false,
            used_count: current.used_count,
          },
          data: { used_count: { increment: 1 } },
        });
        if (updated.count !== 1) {
          // Lost the race to another concurrent redemption — fail closed.
          throw new BadRequestException('Invalid or expired invite code');
        }

        const user = await tx.user.update({
          where: { id: userId },
          data: { role, coach_id: validation.coach_id },
        });
        return user;
      });
      this.analytics.capture(userId, Events.INVITE_REDEEMED, {
        via: 'select_role',
        coach_id: validation.coach_id,
      });
      return { role: result.role, coach_id: result.coach_id };
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      this.logger.warn(`invite code redemption failed for ${inviteCode}: ${(err as Error).message}`);
      throw new BadRequestException('Invalid or expired invite code');
    }
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

    const { error } = await supaClient.auth.resetPasswordForEmail(email, {
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
  }) {
    const gateEnabled =
      (process.env.COACH_CODE_GATE_ENABLED || '').toLowerCase() === 'true';

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
    });

    if (data.invite_code) {
      try {
        await this.inviteCodes.attachUserToCoachByCode(
          registered.user_id,
          data.invite_code,
        );
      } catch (err) {
        this.logger.warn(
          `signupWithCode attach failed for user=${registered.user_id}: ${(err as Error).message}`,
        );
      }
    }

    this.analytics.capture(registered.user_id, Events.USER_SIGNUP_WITH_CODE, {
      had_invite_code: !!data.invite_code,
      gate_enabled: gateEnabled,
    });

    return registered;
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
      throw new UnauthorizedException('Password is incorrect. Provide your current password to become a coach.');
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
      throw new ForbiddenException(
        'Bootstrap endpoint is not enabled on this instance.',
      );
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
        throw new BadRequestException(
          error?.message ?? 'Failed to create Supabase user.',
        );
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
    const { data: signInData, error: signInError } =
      await supaClient.auth.signInWithPassword({
        email: input.email,
        password: input.password,
      });
    if (signInError || !signInData?.session?.access_token) {
      throw new UnauthorizedException(
        'Created owner but could not sign in: ' +
          (signInError?.message ?? 'unknown'),
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
    body: { password?: string; provider_token?: string; provider?: 'google' | 'apple' },
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
        { realtime: { transport: ws as any } },
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
          throw new ServiceUnavailableException(
            'Authentication service temporarily unavailable',
          );
        }
        throw err;
      }
      if (result.error) {
        throw new UnauthorizedException('Password is incorrect');
      }
    } else {
      throw new BadRequestException(
        'Provide either password or provider_token + provider',
      );
    }

    const token = issueRecentAuthToken(userId, secret);
    const ttl = parseTtlMs(process.env.RECENT_AUTH_TTL_MS) ?? RECENT_AUTH_TTL_DEFAULT_MS;

    return { token, expires_in_ms: ttl };
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
    provider: 'google' | 'apple',
    providerToken: string,
  ): Promise<void> {
    const ttl = parseTtlMs(process.env.RECENT_AUTH_TTL_MS) ?? RECENT_AUTH_TTL_DEFAULT_MS;
    const nowSec = Math.floor(Date.now() / 1000);
    const ttlSec = Math.ceil(ttl / 1000);

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
        { realtime: { transport: ws as any } },
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
          throw new ServiceUnavailableException(
            'Authentication service temporarily unavailable',
          );
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
      emailVerified &&
      !!googleEmail &&
      googleEmail.toLowerCase() === user.email.toLowerCase();
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
          throw new ServiceUnavailableException(
            'Authentication service temporarily unavailable',
          );
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
