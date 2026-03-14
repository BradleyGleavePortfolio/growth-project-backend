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
exports.LogController = void 0;
const common_1 = require("@nestjs/common");
const log_service_1 = require("./log.service");
const auth_guard_1 = require("../auth/auth.guard");
let LogController = class LogController {
    constructor(logService) {
        this.logService = logService;
    }
    async logFood(req, body) {
        return this.logService.logFood(req.user.id, body);
    }
    async getDaily(req, date) {
        const d = date || new Date().toISOString().split('T')[0];
        return this.logService.getDaily(req.user.id, d);
    }
    async updateEntry(req, id, body) {
        return this.logService.updateEntry(req.user.id, id, body);
    }
    async deleteEntry(req, id) {
        return this.logService.deleteEntry(req.user.id, id);
    }
    async getWeekly(req, weekStart) {
        const ws = weekStart || new Date().toISOString().split('T')[0];
        return this.logService.getWeekly(req.user.id, ws);
    }
};
exports.LogController = LogController;
__decorate([
    (0, common_1.Post)('food'),
    __param(0, (0, common_1.Request)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], LogController.prototype, "logFood", null);
__decorate([
    (0, common_1.Get)('daily'),
    __param(0, (0, common_1.Request)()),
    __param(1, (0, common_1.Query)('date')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], LogController.prototype, "getDaily", null);
__decorate([
    (0, common_1.Put)('food/:id'),
    __param(0, (0, common_1.Request)()),
    __param(1, (0, common_1.Param)('id')),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", Promise)
], LogController.prototype, "updateEntry", null);
__decorate([
    (0, common_1.Delete)('food/:id'),
    __param(0, (0, common_1.Request)()),
    __param(1, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], LogController.prototype, "deleteEntry", null);
__decorate([
    (0, common_1.Get)('weekly'),
    __param(0, (0, common_1.Request)()),
    __param(1, (0, common_1.Query)('week_start')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], LogController.prototype, "getWeekly", null);
exports.LogController = LogController = __decorate([
    (0, common_1.Controller)('log'),
    (0, common_1.UseGuards)(auth_guard_1.JwtAuthGuard),
    __metadata("design:paramtypes", [log_service_1.LogService])
], LogController);
//# sourceMappingURL=log.controller.js.map