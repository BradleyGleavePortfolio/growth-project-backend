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
exports.HabitsController = void 0;
const common_1 = require("@nestjs/common");
const habits_service_1 = require("./habits.service");
const auth_guard_1 = require("../auth/auth.guard");
let HabitsController = class HabitsController {
    constructor(habitsService) {
        this.habitsService = habitsService;
    }
    async getHabits(req) {
        return this.habitsService.getHabits(req.user.id);
    }
    async createHabit(req, body) {
        return this.habitsService.createHabit(req.user.id, body);
    }
    async logHabit(req, id, body) {
        return this.habitsService.logHabit(req.user.id, id, body);
    }
    async getLogs(req, date) {
        const d = date || new Date().toISOString().split('T')[0];
        return this.habitsService.getLogs(req.user.id, d);
    }
    async getStreaks(req) {
        return this.habitsService.getStreaks(req.user.id);
    }
};
exports.HabitsController = HabitsController;
__decorate([
    (0, common_1.Get)(),
    __param(0, (0, common_1.Request)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], HabitsController.prototype, "getHabits", null);
__decorate([
    (0, common_1.Post)(),
    __param(0, (0, common_1.Request)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], HabitsController.prototype, "createHabit", null);
__decorate([
    (0, common_1.Post)(':id/log'),
    __param(0, (0, common_1.Request)()),
    __param(1, (0, common_1.Param)('id')),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", Promise)
], HabitsController.prototype, "logHabit", null);
__decorate([
    (0, common_1.Get)('logs'),
    __param(0, (0, common_1.Request)()),
    __param(1, (0, common_1.Query)('date')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], HabitsController.prototype, "getLogs", null);
__decorate([
    (0, common_1.Get)('streaks'),
    __param(0, (0, common_1.Request)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], HabitsController.prototype, "getStreaks", null);
exports.HabitsController = HabitsController = __decorate([
    (0, common_1.Controller)('habits'),
    (0, common_1.UseGuards)(auth_guard_1.JwtAuthGuard),
    __metadata("design:paramtypes", [habits_service_1.HabitsService])
], HabitsController);
//# sourceMappingURL=habits.controller.js.map