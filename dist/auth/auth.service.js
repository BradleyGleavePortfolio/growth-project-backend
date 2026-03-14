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
const jwt_1 = require("@nestjs/jwt");
const prisma_service_1 = require("../prisma.service");
const COACH_BACKDOOR_CODE = '6678345';
let AuthService = class AuthService {
    constructor(prisma, jwtService) {
        this.prisma = prisma;
        this.jwtService = jwtService;
        this.supabaseAdmin = (0, supabase_js_1.createClient)(process.env.SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');
    }
    async register(data) {
        const existing = await this.prisma.user.findUnique({ where: { email: data.email } });
        if (existing)
            throw new common_1.ConflictException('Email already registered');
        const { data: supaUser, error } = await this.supabaseAdmin.auth.admin.createUser({
            email: data.email,
            password: data.password,
            email_confirm: true,
        });
        if (error)
            throw new common_1.BadRequestException(error.message);
        const user = await this.prisma.user.create({
            data: {
                supabase_id: supaUser.user.id,
                email: data.email,
                name: data.name,
                phone: data.phone || null,
                role: 'student',
            },
        });
        const supaClient = (0, supabase_js_1.createClient)(process.env.SUPABASE_URL || '', process.env.SUPABASE_ANON_KEY || '');
        const { data: session, error: signInError } = await supaClient.auth.signInWithPassword({
            email: data.email,
            password: data.password,
        });
        if (signInError || !session.session) {
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
    async login(email, password) {
        const supaClient = (0, supabase_js_1.createClient)(process.env.SUPABASE_URL || '', process.env.SUPABASE_ANON_KEY || '');
        const { data, error } = await supaClient.auth.signInWithPassword({ email, password });
        if (error)
            throw new common_1.UnauthorizedException('Invalid email or password');
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
    async googleAuth(googleToken) {
        const supaClient = (0, supabase_js_1.createClient)(process.env.SUPABASE_URL || '', process.env.SUPABASE_ANON_KEY || '');
        const { data, error } = await supaClient.auth.signInWithIdToken({
            provider: 'google',
            token: googleToken,
        });
        if (error)
            throw new common_1.UnauthorizedException('Google auth failed');
        const supaUser = data.user;
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
    async validateSupabaseToken(supabaseId) {
        return this.prisma.user.findUnique({ where: { supabase_id: supabaseId } });
    }
};
exports.AuthService = AuthService;
exports.AuthService = AuthService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        jwt_1.JwtService])
], AuthService);
//# sourceMappingURL=auth.service.js.map