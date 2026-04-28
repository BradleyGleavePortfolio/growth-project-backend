import { Injectable, Logger, UnauthorizedException, BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { createClient } from '@supabase/supabase-js';
import { PrismaService } from '../prisma.service';
import {
  InviteCodesService,
  INVITE_CODE_MAX_LENGTH,
  INVITE_CODE_MIN_LENGTH,
  INVITE_CODE_PREFIX,
} from '../invite-codes/invite-codes.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { Events } from '../analytics/events';
import { AuditAction, AuditService } from '../audit/audit.service';

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
  ) {
    // Supabase Admin SDK for user management (service role key)
    this.supabaseAdmin = createClient(
      process.env.SUPABASE_URL || '',
      process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    );
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

  async login(email: string, password: string) {
    // Authenticate via Supabase
    const supaClient = createClient(
      process.env.SUPABASE_URL || '',
      process.env.SUPABASE_ANON_KEY || '',
    );

    const { data, error } = await supaClient.auth.signInWithPassword({ email, password });

    if (error) {
      // Surface specific errors so the mobile client can handle them
      const msg = error.message || '';
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
    const googleEnabled =
      !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
    const providers = ['email'];
    if (googleEnabled) providers.push('google');
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
      (supaUser.identities || []).map((i: any) => i.provider).filter(Boolean);
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

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      coach_id: user.coach_id,
      profile: user.profile,
    };
  }

  async forgotPassword(email: string) {
    const supaClient = createClient(
      process.env.SUPABASE_URL || '',
      process.env.SUPABASE_ANON_KEY || '',
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
      // Idempotent — already a coach; return current role.
      return { role: user.role };
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

    // Verify password against Supabase before elevating
    const supaClient = createClient(
      process.env.SUPABASE_URL || '',
      process.env.SUPABASE_ANON_KEY || '',
    );
    const { error } = await supaClient.auth.signInWithPassword({
      email: user.email,
      password,
    });
    if (error) {
      throw new UnauthorizedException('Password is incorrect. Provide your current password to become a coach.');
    }

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
    });

    return { role: updated.role };
  }
}
