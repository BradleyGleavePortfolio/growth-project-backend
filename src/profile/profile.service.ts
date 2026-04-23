import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Injectable()
export class ProfileService {
  constructor(private prisma: PrismaService) {}

  async getProfile(userId: string) {
    const profile = await this.prisma.userProfile.findUnique({
      where: { user_id: userId },
    });

    if (!profile) {
      // Return empty profile shell
      return { user_id: userId };
    }

    return profile;
  }

  async updateProfile(userId: string, data: any) {
    // CRITICAL: height_cm stored ONLY in UserProfile — single source of truth
    // SECURITY: explicit allow-list mapping (audit C4). The controller DTO already
    // strips unknown fields via ValidationPipe, but we defend-in-depth by mapping
    // only the permitted fields into Prisma rather than spreading. This prevents
    // any future regression (e.g. DTO drift) from letting a client overwrite
    // `user_id`, `id`, `updated_at`, or any of the `macro_target_*` fields that
    // should be computed server-side by `computeAndSaveMacros`.
    const allowed = {
      height_cm: data.height_cm,
      current_weight_lbs: data.current_weight_lbs,
      target_weight_lbs: data.target_weight_lbs,
      date_of_birth: data.date_of_birth ? new Date(data.date_of_birth) : undefined,
      sex: data.sex,
      activity_level: data.activity_level,
      goal_type: data.goal_type,
      workout_experience: data.workout_experience,
      has_gym_membership: data.has_gym_membership,
      preferred_snacks: data.preferred_snacks,
      avatar_url: data.avatar_url,
    };
    // Drop undefineds so we don't overwrite existing values with NULL.
    const payload: Record<string, any> = {};
    for (const [k, v] of Object.entries(allowed)) {
      if (v !== undefined) payload[k] = v;
    }

    const existing = await this.prisma.userProfile.findUnique({ where: { user_id: userId } });

    if (existing) {
      return this.prisma.userProfile.update({
        where: { user_id: userId },
        data: payload,
      });
    } else {
      return this.prisma.userProfile.create({
        data: { user_id: userId, ...payload },
      });
    }
  }

  async computeAndSaveMacros(userId: string) {
    const profile = await this.prisma.userProfile.findUnique({ where: { user_id: userId } });
    if (!profile) return null;

    const user = await this.prisma.user.findUnique({ where: { id: userId } });

    // Mifflin-St Jeor TDEE calculation
    const weightKg = (profile.current_weight_lbs || 180) * 0.453592;
    const heightCm = profile.height_cm || 175;
    const dobMs = profile.date_of_birth ? new Date().getTime() - new Date(profile.date_of_birth).getTime() : 0;
    const ageYears = dobMs ? Math.floor(dobMs / (365.25 * 24 * 3600 * 1000)) : 30;
    const sex = profile.sex;

    let bmr: number;
    if (sex === 'female') {
      bmr = 10 * weightKg + 6.25 * heightCm - 5 * ageYears - 161;
    } else {
      // male or prefer_not_to_say defaults to male formula
      bmr = 10 * weightKg + 6.25 * heightCm - 5 * ageYears + 5;
    }

    const activityMultipliers: Record<string, number> = {
      sedentary: 1.2,
      light: 1.375,
      moderate: 1.55,
      active: 1.725,
      very_active: 1.9,
    };

    const tdee = bmr * (activityMultipliers[profile.activity_level] || 1.55);

    let targetCalories: number;
    const goal = profile.goal_type;
    if (goal === 'fat_loss') targetCalories = tdee - 500;
    else if (goal === 'muscle_gain') targetCalories = tdee + 300;
    else targetCalories = tdee;

    // Protein: 1g per lb of target bodyweight
    const targetWeightLbs = profile.target_weight_lbs || profile.current_weight_lbs || 180;
    const proteinG = targetWeightLbs; // 1g per lb

    // Fat: 25% of total calories
    const fatG = (targetCalories * 0.25) / 9;

    // Carbs: remaining calories
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
}
