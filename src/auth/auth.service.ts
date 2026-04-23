import { Injectable, UnauthorizedException, BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { createClient } from '@supabase/supabase-js';
import { PrismaService } from '../prisma.service';

@Injectable()
export class AuthService {
  private supabaseAdmin;

  constructor(
    private prisma: PrismaService,
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

  async googleAuth(token: string) {
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

    // Upsert user in our DB (Google users are pre-verified)
    let user = await this.prisma.user.findUnique({ where: { supabase_id: supaUser.id } });
    let isNewUser = false;

    if (!user) {
      // Also check by email in case user registered with email first
      user = await this.prisma.user.findUnique({ where: { email: supaUser.email } });
      
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
            email: supaUser.email,
            name: supaUser.user_metadata?.full_name || supaUser.email,
            role: 'student',
          },
        });
        isNewUser = true;
      }
    }

    return {
      access_token: token,
      is_new_user: isNewUser,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        coach_id: user.coach_id,
      },
    };
  }

  async selectRole(userId: string, role: 'coach' | 'student', _coachCode?: string) {
    // SECURITY: coach elevation via client-supplied code is disabled (audit C3).
    // The previous `CaboRules` backdoor allowed any authenticated user to escalate
    // to the `coach` role and read/write other users' data via other IDOR bugs.
    // Self-service role selection is restricted to `student`. Elevating a user to
    // `coach` must now happen out-of-band (direct SQL by an operator) until we
    // build a proper invite/admin flow. Contract is preserved (body still accepts
    // role + coach_code); we just reject coach requests.
    if (role === 'coach') {
      throw new ForbiddenException(
        'Coach accounts are provisioned manually. Contact support.',
      );
    }

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { role },
    });

    return { role: user.role };
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
      // Don't reveal whether the email exists — always return success
      // Silently swallow — don't reveal if email exists or not
    }

    return { message: 'If an account exists with that email, a reset link has been sent.' };
  }

  async validateSupabaseToken(supabaseId: string) {
    return this.prisma.user.findUnique({ where: { supabase_id: supabaseId } });
  }
}
