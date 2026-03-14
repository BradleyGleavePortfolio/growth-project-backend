"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppModule = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const throttler_1 = require("@nestjs/throttler");
const auth_module_1 = require("./auth/auth.module");
const profile_module_1 = require("./profile/profile.module");
const food_module_1 = require("./food/food.module");
const log_module_1 = require("./log/log.module");
const workout_module_1 = require("./workout/workout.module");
const fasting_module_1 = require("./fasting/fasting.module");
const weight_module_1 = require("./weight/weight.module");
const habits_module_1 = require("./habits/habits.module");
const ai_module_1 = require("./ai/ai.module");
const coach_module_1 = require("./coach/coach.module");
const notifications_module_1 = require("./notifications/notifications.module");
const community_module_1 = require("./community/community.module");
const lessons_module_1 = require("./lessons/lessons.module");
const prisma_service_1 = require("./prisma.service");
let AppModule = class AppModule {
};
exports.AppModule = AppModule;
exports.AppModule = AppModule = __decorate([
    (0, common_1.Module)({
        imports: [
            config_1.ConfigModule.forRoot({ isGlobal: true }),
            throttler_1.ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }]),
            auth_module_1.AuthModule,
            profile_module_1.ProfileModule,
            food_module_1.FoodModule,
            log_module_1.LogModule,
            workout_module_1.WorkoutModule,
            fasting_module_1.FastingModule,
            weight_module_1.WeightModule,
            habits_module_1.HabitsModule,
            ai_module_1.AiModule,
            coach_module_1.CoachModule,
            notifications_module_1.NotificationsModule,
            community_module_1.CommunityModule,
            lessons_module_1.LessonsModule,
        ],
        providers: [prisma_service_1.PrismaService],
    })
], AppModule);
//# sourceMappingURL=app.module.js.map