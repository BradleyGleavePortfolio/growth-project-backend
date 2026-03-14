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
exports.ProfileService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../prisma.service");
let ProfileService = class ProfileService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async getProfile(userId) {
        const profile = await this.prisma.userProfile.findUnique({
            where: { user_id: userId },
        });
        if (!profile) {
            return { user_id: userId };
        }
        return profile;
    }
    async updateProfile(userId, data) {
        const existing = await this.prisma.userProfile.findUnique({ where: { user_id: userId } });
        if (existing) {
            return this.prisma.userProfile.update({
                where: { user_id: userId },
                data,
            });
        }
        else {
            return this.prisma.userProfile.create({
                data: { user_id: userId, ...data },
            });
        }
    }
    async computeAndSaveMacros(userId) {
        const profile = await this.prisma.userProfile.findUnique({ where: { user_id: userId } });
        if (!profile)
            return null;
        const user = await this.prisma.user.findUnique({ where: { id: userId } });
        const weightKg = (profile.current_weight_lbs || 180) * 0.453592;
        const heightCm = profile.height_cm || 175;
        const dobMs = profile.date_of_birth ? new Date().getTime() - new Date(profile.date_of_birth).getTime() : 0;
        const ageYears = dobMs ? Math.floor(dobMs / (365.25 * 24 * 3600 * 1000)) : 30;
        const sex = profile.sex;
        let bmr;
        if (sex === 'female') {
            bmr = 10 * weightKg + 6.25 * heightCm - 5 * ageYears - 161;
        }
        else {
            bmr = 10 * weightKg + 6.25 * heightCm - 5 * ageYears + 5;
        }
        const activityMultipliers = {
            sedentary: 1.2,
            light: 1.375,
            moderate: 1.55,
            active: 1.725,
            very_active: 1.9,
        };
        const tdee = bmr * (activityMultipliers[profile.activity_level] || 1.55);
        let targetCalories;
        const goal = profile.goal_type;
        if (goal === 'fat_loss')
            targetCalories = tdee - 500;
        else if (goal === 'muscle_gain')
            targetCalories = tdee + 300;
        else
            targetCalories = tdee;
        const targetWeightLbs = profile.target_weight_lbs || profile.current_weight_lbs || 180;
        const proteinG = targetWeightLbs;
        const fatG = (targetCalories * 0.25) / 9;
        const carbsG = (targetCalories - proteinG * 4 - fatG * 9) / 4;
        return this.prisma.userProfile.update({
            where: { user_id: userId },
            data: {
                macro_target_calories: Math.round(targetCalories),
                macro_target_protein_g: Math.round(proteinG),
                macro_target_carbs_g: Math.round(Math.max(carbsG, 0)),
                macro_target_fat_g: Math.round(fatG),
            },
        });
    }
};
exports.ProfileService = ProfileService;
exports.ProfileService = ProfileService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], ProfileService);
//# sourceMappingURL=profile.service.js.map