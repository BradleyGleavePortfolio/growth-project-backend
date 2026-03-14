import { Injectable, UnauthorizedException, BadRequestException, ConflictException } from '@nestjs/common';
import { createClient } from '@supabase/supabase-js';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma.service';

const COACH_BACKDOOR_CODE = '6678345';

@Injectable()
export class AuthService {
  private supabaseAdmin;

  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
  ) {
    // Supabase Admin SDK for user management (service role key)
    this.supabaseAdmin = createClient(
      process.env.SUPABASE_URL || '',
      process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    );
  }

  async register(data: { email: string; password: string; name: string; phone?: string }) {
    // Check if user already exists
    const existing = await this.prisma.user.findUnique({ where: { email: data.email } });
    if (existing) throw new ConflictException('Email already registered');

    // Create user in Supabase Auth
    const { data: supaUser, error } = await this.supabaseAdmin.auth.admin.createUser({
      email: data.email,
      password: data.password,
      email_confirm: true, // auto-confirm — no email verification required
    });

    if (error) throw new BadRequestException(error.message);

    // Create user record in our DB
    const user = await this.prisma.user.create({
      data: {
        supabase_id: supaUser.user.id,
        email: data.email,
        name: data.name,
        phone: data.phone || null,
        role: 'student',
      },
    });

    // Auto-confirm is on — sign the user in immediately so the app gets a token
    const supaClient = createClient(
      process.env.SUPABASE_URL || '',
      process.env.SUPABASE_ANON_KEY || '',
    );
    const { data: session, error: signInError } = await supaClient.auth.signInWithPassword({
      email: data.email,
      password: data.password,
    });

    if (signInError || !session.session) {
      // Registration succeeded but couldn't auto-login — still return success
      return { message: 'Account created! Please log in.', user_id: user.id };
    }

    return {
      message: 'Account created!',
      access_token: session.session.access_token,
      is_new_user: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        coach_id: user.coach_id,
      },
    };
  }

  async login(email: string, password: string) {
    // Authenticate via Supabase
    const supaClient = createClient(
      process.env.SUPABASE_URL || '',
      process.env.SUPABASE_ANON_KEY || '',
    );

    const { data, error } = await supaClient.auth.signInWithPassword({ email, password });

    if (error) throw new UnauthorizedException('Invalid email or password');

    // Find user in our DB
    const user = await this.prisma.user.findUnique({
      where: { email },
      include: { profile: true },
    });

    if (!user) throw new UnauthorizedException('User not found');

    // Return Supabase access token + our user record
    return {
      access_token: data.session.access_token,
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

  async googleAuth(googleToken: string) {
    // Exchange Google ID token with Supabase
    const supaClient = createClient(
      process.env.SUPABASE_URL || '',
      process.env.SUPABASE_ANON_KEY || '',
    );

    const { data, error } = await supaClient.auth.signInWithIdToken({
      provider: 'google',
      token: googleToken,
    });

    if (error) throw new UnauthorizedException('Google auth failed');

    const supaUser = data.user;

    // Upsert user in our DB (Google users are pre-verified)
    let user = await this.prisma.user.findUnique({ where: { supabase_id: supaUser.id } });

    if (!user) {
      user = await this.prisma.user.create({
        data: {
          supabase_id: supaUser.id,
          email: supaUser.email,
          name: supaUser.user_metadata?.full_name || supaUser.email,
          role: 'student',
        },
      });
    }

    return {
      access_token: data.session.access_token,
      is_new_user: false,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        coach_id: user.coach_id,
      },
    };
  }

  async selectRole(userId: string, role: 'coach' | 'student', coachCode?: string) {
    if (role === 'coach') {
      if (coachCode !== COACH_BACKDOOR_CODE) {
        throw new UnauthorizedException('Incorrect code. Contact support.');
      }
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

  async validateSupabaseToken(supabaseId: string) {
    return this.prisma.user.findUnique({ where: { supabase_id: supabaseId } });
  }
}
