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
exports.CoachService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../prisma.service");
let CoachService = class CoachService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async getClients(coachId) {
        return this.prisma.user.findMany({
            where: { coach_id: coachId, role: 'student' },
            include: { profile: true },
            orderBy: { created_at: 'desc' },
        });
    }
    async getClientTimeline(coachId, clientId, days = 90) {
        const client = await this.prisma.user.findFirst({
            where: { id: clientId, coach_id: coachId },
        });
        if (!client)
            return { error: 'Client not found' };
        const ninetyDaysAgo = new Date();
        ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - days);
        const [meals, workouts, weights, checkIns] = await Promise.all([
            this.prisma.loggedFoodEntry.findMany({
                where: { user_id: clientId, logged_at: { gte: ninetyDaysAgo } },
                include: { food_item: true },
                orderBy: { logged_at: 'desc' },
            }),
            this.prisma.workoutSession.findMany({
                where: { user_id: clientId, created_at: { gte: ninetyDaysAgo } },
                include: { exercises: true },
                orderBy: { created_at: 'desc' },
            }),
            this.prisma.weightLog.findMany({
                where: { user_id: clientId, date: { gte: ninetyDaysAgo } },
                orderBy: { date: 'desc' },
            }),
            this.prisma.checkIn.findMany({
                where: { user_id: clientId, date: { gte: ninetyDaysAgo } },
                orderBy: { date: 'desc' },
            }),
        ]);
        return { client, meals, workouts, weights, checkIns };
    }
    async postGuidelines(coachId, clientId, guidelines) {
        return this.prisma.lesson.create({
            data: {
                coach_id: coachId,
                title: `Guidelines for Client`,
                description: guidelines,
                tags: [`client:${clientId}`],
                goal_tags: [],
            },
        });
    }
    async getGuidelines(coachOrClientId, clientId) {
        const targetId = clientId || coachOrClientId;
        const lessons = await this.prisma.lesson.findMany({
            where: { tags: { has: `client:${targetId}` } },
            orderBy: { created_at: 'desc' },
            take: 1,
        });
        return lessons[0] || null;
    }
    async getClientSummary(coachId, clientId, date) {
        const client = await this.prisma.user.findFirst({
            where: { id: clientId, coach_id: coachId },
            include: { profile: true },
        });
        if (!client)
            return { error: 'Client not found' };
        const today = date || new Date().toISOString().split('T')[0];
        const startOfDay = new Date(today + 'T00:00:00.000Z');
        const endOfDay = new Date(today + 'T23:59:59.999Z');
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        const [todayEntries, weightLogs, recentWorkouts] = await Promise.all([
            this.prisma.loggedFoodEntry.findMany({
                where: { user_id: clientId, logged_at: { gte: startOfDay, lte: endOfDay } },
                include: { food_item: true },
                orderBy: { logged_at: 'asc' },
            }),
            this.prisma.weightLog.findMany({
                where: { user_id: clientId, date: { gte: thirtyDaysAgo } },
                orderBy: { date: 'desc' },
            }),
            this.prisma.workoutSession.findMany({
                where: { user_id: clientId },
                include: { exercises: true },
                orderBy: { created_at: 'desc' },
                take: 10,
            }),
        ]);
        let total_calories = 0, total_protein_g = 0, total_carbs_g = 0, total_fat_g = 0;
        for (const entry of todayEntries) {
            const qty = entry.quantity_multiplier || 1;
            const fi = entry.food_item;
            if (fi) {
                total_calories += (fi.calories || 0) * qty;
                total_protein_g += (fi.protein_g || 0) * qty;
                total_carbs_g += (fi.carbs_g || 0) * qty;
                total_fat_g += (fi.fat_g || 0) * qty;
            }
        }
        return {
            profile: client.profile,
            client_name: client.name,
            today: {
                entries: todayEntries,
                total_calories: Math.round(total_calories),
                total_protein_g: Math.round(total_protein_g),
                total_carbs_g: Math.round(total_carbs_g),
                total_fat_g: Math.round(total_fat_g),
            },
            weight_logs: weightLogs,
            recent_workouts: recentWorkouts,
        };
    }
    async getAlerts(coachId) {
        const clients = await this.prisma.user.findMany({
            where: { coach_id: coachId, role: 'student' },
        });
        const alerts = [];
        for (const client of clients) {
            const weightLogs = await this.prisma.weightLog.findMany({
                where: { user_id: client.id },
                orderBy: { date: 'desc' },
                take: 4,
            });
            if (weightLogs.length >= 3) {
                let weightUp = true;
                for (let i = 0; i < weightLogs.length - 1; i++) {
                    if (weightLogs[i].weight_lbs <= weightLogs[i + 1].weight_lbs) {
                        weightUp = false;
                        break;
                    }
                }
                if (weightUp) {
                    alerts.push({
                        type: 'weight_increasing',
                        client_id: client.id,
                        client_name: client.name,
                        message: `${client.name} weight has increased 3+ consecutive days`,
                    });
                }
            }
            const fiveDaysAgo = new Date();
            fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);
            const recentWorkout = await this.prisma.workoutSession.findFirst({
                where: { user_id: client.id, date: { gte: fiveDaysAgo } },
            });
            if (!recentWorkout) {
                alerts.push({
                    type: 'missed_workouts',
                    client_id: client.id,
                    client_name: client.name,
                    message: `${client.name} has not logged a workout in 5+ days`,
                });
            }
        }
        return alerts;
    }
};
exports.CoachService = CoachService;
exports.CoachService = CoachService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], CoachService);
//# sourceMappingURL=coach.service.js.map