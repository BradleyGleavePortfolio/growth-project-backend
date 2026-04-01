"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthService = void 0;
const common_1 = require("@nestjs/common");
const supabase_js_1 = require("@supabase/supabase-js");
const prisma_service_1 = require("../prisma.service");
const COACH_BACKDOOR_CODE = 'CaboRules';
let AuthService = class AuthService {
    constructor(prisma) {
        this.prisma = prisma;
        this.supabaseAdmin = (0, supabase_js_1.createClient)(process.env.SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');
    }
    async register(data) {
        const { password } = data;
        if (password.length < 8 ||
            !/[A-Z]/.test(password) ||
            !/[0-9]/.test(password) ||
            !/[^A-Za-z0-9]/.test(password)) {
            throw new common_1.BadRequestException('Password must be at least 8 characters with one uppercase letter, one number, and one special character.');
        }
        const existing = await this.prisma.user.findUnique({ where: { email: data.email } });
        if (existing)
            throw new common_1.ConflictException('Email already registered');
        const supaClient = (0, supabase_js_1.createClient)(process.env.SUPABASE_URL || '', process.env.SUPABASE_ANON_KEY || '');
        const { data: signupData, error } = await supaClient.auth.signUp({
            email: data.email,
            password: data.password,
            options: {
                emailRedirectTo: `${process.env.SUPABASE_REDIRECT_URL || 'tgp://verified'}`,
                data: { full_name: data.name },
            },
        });
        if (error)
            throw new common_1.BadRequestException(error.message);
        if (!signupData.user)
            throw new common_1.BadRequestException('Signup failed');
        const user = await this.prisma.user.create({
            data: {
                supabase_id: signupData.user.id,
                email: data.email,
                name: data.name,
                phone: data.phone || null,
                role: 'student',
            },
        });
        return {
            message: 'Verification email sent! Please check your inbox.',
            requires_verification: true,
            user_id: user.id,
            email: data.email,
        };
    }
    async login(email, password) {
        const supaClient = (0, supabase_js_1.createClient)(process.env.SUPABASE_URL || '', process.env.SUPABASE_ANON_KEY || '');
        const { data, error } = await supaClient.auth.signInWithPassword({ email, password });
        if (error) {
            const msg = error.message || '';
            if (msg.toLowerCase().includes('email') && msg.toLowerCase().includes('confirm')) {
                throw new common_1.UnauthorizedException('Email not confirmed. Please check your inbox and verify your email first.');
            }
            throw new common_1.UnauthorizedException('Invalid email or password');
        }
        const user = await this.prisma.user.findUnique({
            where: { email },
            include: { profile: true },
        });
        if (!user)
            throw new common_1.UnauthorizedException('User not found');
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
    async googleAuth(token) {
        const { data: userData, error: userError } = await this.supabaseAdmin.auth.getUser(token);
        if (userError || !userData.user) {
            throw new common_1.UnauthorizedException('Google auth failed — invalid token');
        }
        const supaUser = userData.user;
        let user = await this.prisma.user.findUnique({ where: { supabase_id: supaUser.id } });
        let isNewUser = false;
        if (!user) {
            user = await this.prisma.user.findUnique({ where: { email: supaUser.email } });
            if (user) {
                user = await this.prisma.user.update({
                    where: { id: user.id },
                    data: { supabase_id: supaUser.id },
                });
            }
            else {
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
    async selectRole(userId, role, coachCode) {
        if (role === 'coach') {
            if (coachCode !== COACH_BACKDOOR_CODE) {
                throw new common_1.UnauthorizedException('Incorrect code. Contact support.');
            }
        }
        const user = await this.prisma.user.update({
            where: { id: userId },
            data: { role },
        });
        return { role: user.role };
    }
    async getMe(userId) {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            include: { profile: true },
        });
        if (!user)
            throw new common_1.UnauthorizedException('User not found');
        return {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
            coach_id: user.coach_id,
            profile: user.profile,
        };
    }
    async forgotPassword(email) {
        const supaClient = (0, supabase_js_1.createClient)(process.env.SUPABASE_URL || '', process.env.SUPABASE_ANON_KEY || '');
        const { error } = await supaClient.auth.resetPasswordForEmail(email, {
            redirectTo: 'tgp://reset-password',
        });
        if (error) {
        }
        return { message: 'If an account exists with that email, a reset link has been sent.' };
    }
    async validateSupabaseToken(supabaseId) {
        return this.prisma.user.findUnique({ where: { supabase_id: supabaseId } });
    }
};
exports.AuthService = AuthService;
exports.AuthService = AuthService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], AuthService);
//# sourceMappingURL=auth.service.js.map