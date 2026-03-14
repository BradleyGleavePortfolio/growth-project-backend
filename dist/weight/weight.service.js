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
exports.WeightService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../prisma.service");
let WeightService = class WeightService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async logWeight(userId, data) {
        return this.prisma.weightLog.create({
            data: {
                user_id: userId,
                date: data.date ? new Date(data.date) : new Date(),
                weight_lbs: data.weight_lbs,
                notes: data.notes,
            },
        });
    }
    async getHistory(userId, days = 30) {
        const start = new Date();
        start.setDate(start.getDate() - days);
        const logs = await this.prisma.weightLog.findMany({
            where: { user_id: userId, date: { gte: start } },
            orderBy: { date: 'asc' },
        });
        const profile = await this.prisma.userProfile.findUnique({ where: { user_id: userId } });
        return { logs, height_cm: profile?.height_cm || null };
    }
};
exports.WeightService = WeightService;
exports.WeightService = WeightService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], WeightService);
//# sourceMappingURL=weight.service.js.map