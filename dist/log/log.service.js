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
exports.LogService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../prisma.service");
let LogService = class LogService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async logFood(userId, data) {
        return this.prisma.loggedFoodEntry.create({
            data: {
                user_id: userId,
                date: new Date(data.date),
                meal_type: data.meal_type,
                food_item_id: data.food_item_id,
                quantity_multiplier: data.quantity_multiplier || 1.0,
                notes: data.notes,
            },
            include: { food_item: true },
        });
    }
    async getDaily(userId, date) {
        const targetDate = new Date(date);
        const entries = await this.prisma.loggedFoodEntry.findMany({
            where: { user_id: userId, date: targetDate },
            include: { food_item: true },
            orderBy: { logged_at: 'asc' },
        });
        const profile = await this.prisma.userProfile.findUnique({ where: { user_id: userId } });
        let total_calories = 0, total_protein_g = 0, total_carbs_g = 0, total_fat_g = 0;
        entries.forEach(e => {
            const q = e.quantity_multiplier;
            total_calories += e.food_item.calories * q;
            total_protein_g += e.food_item.protein_g * q;
            total_carbs_g += e.food_item.carbs_g * q;
            total_fat_g += e.food_item.fat_g * q;
        });
        return {
            date,
            entries,
            total_calories: Math.round(total_calories),
            total_protein_g: Math.round(total_protein_g),
            total_carbs_g: Math.round(total_carbs_g),
            total_fat_g: Math.round(total_fat_g),
            remaining_calories: Math.round((profile?.macro_target_calories || 2000) - total_calories),
            remaining_protein_g: Math.round((profile?.macro_target_protein_g || 180) - total_protein_g),
            remaining_carbs_g: Math.round((profile?.macro_target_carbs_g || 200) - total_carbs_g),
            remaining_fat_g: Math.round((profile?.macro_target_fat_g || 60) - total_fat_g),
            macro_targets: {
                calories: profile?.macro_target_calories || 2000,
                protein_g: profile?.macro_target_protein_g || 180,
                carbs_g: profile?.macro_target_carbs_g || 200,
                fat_g: profile?.macro_target_fat_g || 60,
            },
        };
    }
    async updateEntry(userId, entryId, data) {
        const entry = await this.prisma.loggedFoodEntry.findUnique({ where: { id: entryId } });
        if (!entry || entry.user_id !== userId)
            throw new common_1.NotFoundException('Entry not found');
        return this.prisma.loggedFoodEntry.update({ where: { id: entryId }, data });
    }
    async deleteEntry(userId, entryId) {
        const entry = await this.prisma.loggedFoodEntry.findUnique({ where: { id: entryId } });
        if (!entry || entry.user_id !== userId)
            throw new common_1.NotFoundException('Entry not found');
        return this.prisma.loggedFoodEntry.delete({ where: { id: entryId } });
    }
    async getWeekly(userId, weekStart) {
        const start = new Date(weekStart);
        const end = new Date(start);
        end.setDate(end.getDate() + 7);
        const entries = await this.prisma.loggedFoodEntry.findMany({
            where: { user_id: userId, date: { gte: start, lt: end } },
            include: { food_item: true },
            orderBy: { date: 'asc' },
        });
        const byDate = {};
        entries.forEach(e => {
            const d = e.date.toISOString().split('T')[0];
            if (!byDate[d])
                byDate[d] = { date: d, calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
            byDate[d].calories += e.food_item.calories * e.quantity_multiplier;
            byDate[d].protein_g += e.food_item.protein_g * e.quantity_multiplier;
            byDate[d].carbs_g += e.food_item.carbs_g * e.quantity_multiplier;
            byDate[d].fat_g += e.food_item.fat_g * e.quantity_multiplier;
        });
        return Object.values(byDate);
    }
};
exports.LogService = LogService;
exports.LogService = LogService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], LogService);
//# sourceMappingURL=log.service.js.map