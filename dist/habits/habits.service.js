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
exports.HabitsService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../prisma.service");
let HabitsService = class HabitsService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async getHabits(userId) {
        return this.prisma.habit.findMany({
            where: { user_id: userId },
            include: { logs: { orderBy: { date: 'desc' }, take: 30 } },
        });
    }
    async createHabit(userId, data) {
        return this.prisma.habit.create({ data: { ...data, user_id: userId } });
    }
    async logHabit(userId, habitId, data) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const existing = await this.prisma.habitLog.findFirst({
            where: { habit_id: habitId, date: today },
        });
        if (existing) {
            return this.prisma.habitLog.update({ where: { id: existing.id }, data });
        }
        return this.prisma.habitLog.create({
            data: { habit_id: habitId, date: today, ...data },
        });
    }
    async getStreaks(userId) {
        const habits = await this.prisma.habit.findMany({
            where: { user_id: userId },
            include: { logs: { orderBy: { date: 'desc' }, take: 90 } },
        });
        return habits.map(h => {
            let streak = 0;
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            for (let i = 0; i < 90; i++) {
                const checkDate = new Date(today);
                checkDate.setDate(checkDate.getDate() - i);
                const log = h.logs.find(l => {
                    const d = new Date(l.date);
                    d.setHours(0, 0, 0, 0);
                    return d.getTime() === checkDate.getTime();
                });
                if (log && log.completed)
                    streak++;
                else
                    break;
            }
            return { habit_id: h.id, habit_name: h.name, streak };
        });
    }
};
exports.HabitsService = HabitsService;
exports.HabitsService = HabitsService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], HabitsService);
//# sourceMappingURL=habits.service.js.map