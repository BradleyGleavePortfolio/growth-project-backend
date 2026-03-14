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
exports.WorkoutService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../prisma.service");
let WorkoutService = class WorkoutService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async createWorkout(userId, data) {
        const { exercises, ...sessionData } = data;
        return this.prisma.workoutSession.create({
            data: {
                ...sessionData,
                user_id: userId,
                date: new Date(sessionData.date || new Date()),
                exercises: exercises ? { create: exercises } : undefined,
            },
            include: { exercises: true },
        });
    }
    async getWorkouts(userId, limit = 10) {
        return this.prisma.workoutSession.findMany({
            where: { user_id: userId },
            include: { exercises: true },
            orderBy: { date: 'desc' },
            take: limit,
        });
    }
    async getVolume(userId, period = 'week') {
        const start = new Date();
        if (period === 'week')
            start.setDate(start.getDate() - 7);
        else
            start.setMonth(start.getMonth() - 1);
        const sessions = await this.prisma.workoutSession.findMany({
            where: { user_id: userId, date: { gte: start } },
            include: { exercises: true },
        });
        const volumeMap = {};
        sessions.forEach(s => {
            s.exercises.forEach(e => {
                const vol = e.sets_completed > 0
                    ? e.weight_per_set.reduce((acc, w, i) => acc + w * (e.reps_per_set[i] || 0), 0)
                    : 0;
                volumeMap[e.muscle_group] = (volumeMap[e.muscle_group] || 0) + vol;
            });
        });
        return Object.entries(volumeMap).map(([muscle_group, total_volume]) => ({
            muscle_group,
            total_volume: Math.round(total_volume),
            period,
        }));
    }
    async getRoutines(userId) {
        return this.prisma.workoutRoutine.findMany({
            where: { OR: [{ creator_id: userId }, { is_template: true }] },
            include: { exercises: { orderBy: { order_index: 'asc' } } },
        });
    }
    async createRoutine(userId, data) {
        const { exercises, ...routineData } = data;
        return this.prisma.workoutRoutine.create({
            data: {
                ...routineData,
                creator_id: userId,
                exercises: exercises ? { create: exercises } : undefined,
            },
            include: { exercises: true },
        });
    }
    async updateRoutine(userId, id, data) {
        const routine = await this.prisma.workoutRoutine.findUnique({ where: { id } });
        if (!routine || routine.creator_id !== userId)
            throw new common_1.NotFoundException('Routine not found');
        return this.prisma.workoutRoutine.update({ where: { id }, data });
    }
    async deleteRoutine(userId, id) {
        const routine = await this.prisma.workoutRoutine.findUnique({ where: { id } });
        if (!routine || routine.creator_id !== userId)
            throw new common_1.NotFoundException('Routine not found');
        return this.prisma.workoutRoutine.delete({ where: { id } });
    }
};
exports.WorkoutService = WorkoutService;
exports.WorkoutService = WorkoutService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], WorkoutService);
//# sourceMappingURL=workout.service.js.map