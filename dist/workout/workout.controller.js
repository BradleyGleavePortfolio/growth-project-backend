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
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WorkoutController = void 0;
const common_1 = require("@nestjs/common");
const workout_service_1 = require("./workout.service");
const auth_guard_1 = require("../auth/auth.guard");
let WorkoutController = class WorkoutController {
    constructor(workoutService) {
        this.workoutService = workoutService;
    }
    async createWorkout(req, body) {
        return this.workoutService.createWorkout(req.user.id, body);
    }
    async getWorkouts(req, limit) {
        return this.workoutService.getWorkouts(req.user.id, limit ? parseInt(limit) : 10);
    }
    async getVolume(req, period) {
        return this.workoutService.getVolume(req.user.id, period || 'week');
    }
    async getRoutines(req) {
        return this.workoutService.getRoutines(req.user.id);
    }
    async createRoutine(req, body) {
        return this.workoutService.createRoutine(req.user.id, body);
    }
    async updateRoutine(req, id, body) {
        return this.workoutService.updateRoutine(req.user.id, id, body);
    }
    async deleteRoutine(req, id) {
        return this.workoutService.deleteRoutine(req.user.id, id);
    }
};
exports.WorkoutController = WorkoutController;
__decorate([
    (0, common_1.Post)('workouts'),
    __param(0, (0, common_1.Request)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], WorkoutController.prototype, "createWorkout", null);
__decorate([
    (0, common_1.Get)('workouts'),
    __param(0, (0, common_1.Request)()),
    __param(1, (0, common_1.Query)('limit')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], WorkoutController.prototype, "getWorkouts", null);
__decorate([
    (0, common_1.Get)('workouts/volume'),
    __param(0, (0, common_1.Request)()),
    __param(1, (0, common_1.Query)('period')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], WorkoutController.prototype, "getVolume", null);
__decorate([
    (0, common_1.Get)('routines'),
    __param(0, (0, common_1.Request)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], WorkoutController.prototype, "getRoutines", null);
__decorate([
    (0, common_1.Post)('routines'),
    __param(0, (0, common_1.Request)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], WorkoutController.prototype, "createRoutine", null);
__decorate([
    (0, common_1.Put)('routines/:id'),
    __param(0, (0, common_1.Request)()),
    __param(1, (0, common_1.Param)('id')),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", Promise)
], WorkoutController.prototype, "updateRoutine", null);
__decorate([
    (0, common_1.Delete)('routines/:id'),
    __param(0, (0, common_1.Request)()),
    __param(1, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], WorkoutController.prototype, "deleteRoutine", null);
exports.WorkoutController = WorkoutController = __decorate([
    (0, common_1.Controller)(),
    (0, common_1.UseGuards)(auth_guard_1.JwtAuthGuard),
    __metadata("design:paramtypes", [workout_service_1.WorkoutService])
], WorkoutController);
//# sourceMappingURL=workout.controller.js.map