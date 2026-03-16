import { Injectable, UnauthorizedException, BadRequestException, ConflictException } from '@nestjs/common';
import { createClient } from '@supabase/supabase-js';
import { PrismaService } from '../prisma.service';

const COACH_BACKDOOR_CODE = '6678345';

@Injectable()
export class AuthService {
  private supabaseAdmin;

  constructor(private prisma: PrismaService) {
    this.supabaseAdmin = createClient(
      process.env.SUPABASE_URL || '',
      process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    );
  }

  async register(data: { email: string; password: string; name: string; phone?: string }) {
    const existing = await this.prisma.user.findUnique({ where: { email: data.email } });
    if (existing) throw new ConflictException('Email already registered');
    const supaClient = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_ANON_KEY || '');
    const { data: signupData, error } = await supaClient.auth.signUp({
      email: data.email,
      password: data.password,
      options: { emailRedirectTo: 'tgp://verified', data: { full_name: data.name } },
    });
    if (error) throw new BadRequestException(error.message);
    if (!signupData.user) throw new BadRequestException('Signup failed');
    const user = await this.prisma.user.create({
      data: { supabase_id: signupData.user.id, email: data.email, name: data.name, phone: data.phone || null, role: 'student' },
    });
    return { message: 'Verification email sent! Please check your inbox.', requires_verification: true, user_id: user.id, email: data.email };
  }

  async login(email: string, password: string) {
    const supaClient = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_ANON_KEY || '');
    const { data, error } = await supaClient.auth.signInWithPassword({ email, password });
    if (error) throw new UnauthorizedException('Invalid email or password');
    const user = await this.prisma.user.findUnique({ where: { email }, include: { profile: true } });
    if (!user) throw new UnauthorizedException('User not found');
    return { access_token: data.session.access_token, user: { id: user.id, email: user.email, name: user.name, role: user.role, coach_id: user.coach_id, profile: user.profile } };
  }

  async selectRole(userId: string, role: 'coach' | 'student', coachCode?: string) {
    if (role === 'coach' && coachCode !== COACH_BACKDOOR_CODE) {
      throw new UnauthorizedException('Incorrect code. Contact support.');
    }
    const user = await this.prisma.user.update({ where: { id: userId }, data: { role } });
    return { role: user.role };
  }

  async getMe(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, include: { profile: true } });
    if (!user) throw new UnauthorizedException('User not found');
    return { id: user.id, email: user.email, name: user.name, role: user.role, coach_id: user.coach_id, profile: user.profile };
  }

  async validateSupabaseToken(supabaseId: string) {
    return this.prisma.user.findUnique({ where: { supabase_id: supabaseId } });
  }
}
