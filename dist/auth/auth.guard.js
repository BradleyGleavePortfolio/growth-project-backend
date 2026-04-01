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
exports.JwtAuthGuard = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../prisma.service");
const supabase_service_1 = require("../supabase/supabase.service");
let JwtAuthGuard = class JwtAuthGuard {
    constructor(prisma, supabaseService) {
        this.prisma = prisma;
        this.supabaseService = supabaseService;
    }
    async canActivate(context) {
        const req = context.switchToHttp().getRequest();
        const authHeader = req.headers?.authorization || '';
        if (!authHeader.startsWith('Bearer ')) {
            throw new common_1.UnauthorizedException('No authentication token provided');
        }
        const token = authHeader.slice(7).trim();
        if (!token) {
            throw new common_1.UnauthorizedException('No authentication token provided');
        }
        const supabase = this.supabaseService.getClient();
        const { data, error } = await supabase.auth.getUser(token);
        if (error || !data?.user) {
            throw new common_1.UnauthorizedException('Invalid or expired token');
        }
        const user = await this.prisma.user.findUnique({
            where: { supabase_id: data.user.id },
        });
        if (!user) {
            throw new common_1.UnauthorizedException('User not found');
        }
        req.user = user;
        return true;
    }
};
exports.JwtAuthGuard = JwtAuthGuard;
exports.JwtAuthGuard = JwtAuthGuard = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        supabase_service_1.SupabaseService])
], JwtAuthGuard);
//# sourceMappingURL=auth.guard.js.map