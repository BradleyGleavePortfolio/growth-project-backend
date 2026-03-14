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
exports.CommunityService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../prisma.service");
let CommunityService = class CommunityService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async getLeaderboard(userId, period = 'week') {
        const user = await this.prisma.user.findUnique({ where: { id: userId } });
        const coachId = user?.role === 'coach' ? user.id : user?.coach_id;
        if (!coachId)
            return [];
        const students = await this.prisma.user.findMany({
            where: { coach_id: coachId, role: 'student' },
        });
        const start = new Date();
        if (period === 'week')
            start.setDate(start.getDate() - 7);
        else
            start.setMonth(start.getMonth() - 1);
        const leaderboard = await Promise.all(students.map(async (s) => {
            const workouts = await this.prisma.workoutSession.count({
                where: { user_id: s.id, date: { gte: start } },
            });
            return { user_id: s.id, name: s.name, workouts_completed: workouts };
        }));
        return leaderboard.sort((a, b) => b.workouts_completed - a.workouts_completed);
    }
    async getFeed(userId) {
        const user = await this.prisma.user.findUnique({ where: { id: userId } });
        const coachId = user?.role === 'coach' ? user.id : user?.coach_id;
        if (!coachId)
            return [];
        return this.prisma.lesson.findMany({
            where: { coach_id: coachId },
            orderBy: { created_at: 'desc' },
            take: 20,
        });
    }
    async postWin(userId, data) {
        return { message: 'Win posted', data };
    }
};
exports.CommunityService = CommunityService;
exports.CommunityService = CommunityService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], CommunityService);
//# sourceMappingURL=community.service.js.map