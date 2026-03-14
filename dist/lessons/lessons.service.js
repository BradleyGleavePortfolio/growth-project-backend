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
exports.LessonsService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../prisma.service");
let LessonsService = class LessonsService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async getLessons(userId) {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            include: { profile: true },
        });
        const coachId = user?.role === 'coach' ? user.id : user?.coach_id;
        const where = {};
        if (coachId)
            where.coach_id = coachId;
        if (user?.profile?.goal_type) {
            where.OR = [
                { goal_tags: { has: user.profile.goal_type } },
                { goal_tags: { isEmpty: true } },
            ];
        }
        return this.prisma.lesson.findMany({
            where,
            include: { completions: { where: { user_id: userId } } },
            orderBy: [{ order_index: 'asc' }, { created_at: 'desc' }],
        });
    }
    async createLesson(userId, data) {
        const user = await this.prisma.user.findUnique({ where: { id: userId } });
        if (user?.role !== 'coach')
            throw new common_1.ForbiddenException('Coach access required');
        return this.prisma.lesson.create({
            data: { ...data, coach_id: userId },
        });
    }
    async updateLesson(userId, id, data) {
        const user = await this.prisma.user.findUnique({ where: { id: userId } });
        if (user?.role !== 'coach')
            throw new common_1.ForbiddenException('Coach access required');
        return this.prisma.lesson.update({ where: { id }, data });
    }
    async completeLesson(userId, lessonId) {
        const existing = await this.prisma.lessonCompletion.findFirst({
            where: { user_id: userId, lesson_id: lessonId },
        });
        if (existing)
            return existing;
        return this.prisma.lessonCompletion.create({
            data: { user_id: userId, lesson_id: lessonId },
        });
    }
    async getRecommended(userId) {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            include: { profile: true, lesson_completions: true },
        });
        const completedIds = user?.lesson_completions.map(c => c.lesson_id) || [];
        return this.prisma.lesson.findMany({
            where: {
                id: { notIn: completedIds },
                coach_id: user?.coach_id || undefined,
            },
            take: 5,
            orderBy: { order_index: 'asc' },
        });
    }
};
exports.LessonsService = LessonsService;
exports.LessonsService = LessonsService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], LessonsService);
//# sourceMappingURL=lessons.service.js.map