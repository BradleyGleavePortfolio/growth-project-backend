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
exports.FastingService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../prisma.service");
let FastingService = class FastingService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async startFast(userId, data) {
        const active = await this.prisma.fastingWindow.findFirst({
            where: { user_id: userId, end_time: null },
        });
        if (active)
            throw new common_1.BadRequestException('A fast is already in progress');
        return this.prisma.fastingWindow.create({
            data: { user_id: userId, start_time: new Date(), protocol: data.protocol, notes: data.notes },
        });
    }
    async endFast(userId, notes) {
        const active = await this.prisma.fastingWindow.findFirst({
            where: { user_id: userId, end_time: null },
            orderBy: { start_time: 'desc' },
        });
        if (!active)
            throw new common_1.BadRequestException('No active fast found');
        return this.prisma.fastingWindow.update({
            where: { id: active.id },
            data: { end_time: new Date(), notes: notes || active.notes },
        });
    }
    async getHistory(userId, limit = 10) {
        return this.prisma.fastingWindow.findMany({
            where: { user_id: userId },
            orderBy: { start_time: 'desc' },
            take: limit,
        });
    }
};
exports.FastingService = FastingService;
exports.FastingService = FastingService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], FastingService);
//# sourceMappingURL=fasting.service.js.map