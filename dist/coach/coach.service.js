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
    async getClientTimeline(coachId, clientId) {
        const client = await this.prisma.user.findFirst({
            where: { id: clientId, coach_id: coachId },
        });
        if (!client)
            return { error: 'Client not found' };
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        const [meals, workouts, weights, checkIns] = await Promise.all([
            this.prisma.loggedFoodEntry.findMany({
                where: { user_id: clientId, logged_at: { gte: sevenDaysAgo } },
                include: { food_item: true },
                orderBy: { logged_at: 'desc' },
            }),
            this.prisma.workoutSession.findMany({
                where: { user_id: clientId, created_at: { gte: sevenDaysAgo } },
                include: { exercises: true },
                orderBy: { created_at: 'desc' },
            }),
            this.prisma.weightLog.findMany({
                where: { user_id: clientId, date: { gte: sevenDaysAgo } },
                orderBy: { date: 'desc' },
            }),
            this.prisma.checkIn.findMany({
                where: { user_id: clientId, date: { gte: sevenDaysAgo } },
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