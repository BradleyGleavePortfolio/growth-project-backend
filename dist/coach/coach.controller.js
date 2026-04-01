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
exports.CoachController = void 0;
const common_1 = require("@nestjs/common");
const coach_service_1 = require("./coach.service");
const auth_guard_1 = require("../auth/auth.guard");
const coach_guard_1 = require("../auth/coach.guard");
let CoachController = class CoachController {
    constructor(coachService) {
        this.coachService = coachService;
    }
    async getClients(req) {
        return this.coachService.getClients(req.user.id);
    }
    async getClientTimeline(req, id, days) {
        const daysNum = days ? parseInt(days, 10) : 90;
        return this.coachService.getClientTimeline(req.user.id, id, daysNum);
    }
    async getClientSummary(req, clientId, date) {
        return this.coachService.getClientSummary(req.user.id, clientId, date);
    }
    async getMyGuidelines(req) {
        return this.coachService.getGuidelines(req.user.id);
    }
    async getGuidelines(req, clientId) {
        return this.coachService.getGuidelines(req.user.id, clientId);
    }
    async postGuidelines(req, clientId, body) {
        return this.coachService.postGuidelines(req.user.id, clientId, body.guidelines);
    }
    async getAlerts(req) {
        return this.coachService.getAlerts(req.user.id);
    }
};
exports.CoachController = CoachController;
__decorate([
    (0, common_1.Get)('clients'),
    __param(0, (0, common_1.Request)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], CoachController.prototype, "getClients", null);
__decorate([
    (0, common_1.Get)('clients/:id/timeline'),
    __param(0, (0, common_1.Request)()),
    __param(1, (0, common_1.Param)('id')),
    __param(2, (0, common_1.Query)('days')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String]),
    __metadata("design:returntype", Promise)
], CoachController.prototype, "getClientTimeline", null);
__decorate([
    (0, common_1.Get)('clients/:id/summary'),
    __param(0, (0, common_1.Request)()),
    __param(1, (0, common_1.Param)('id')),
    __param(2, (0, common_1.Query)('date')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String]),
    __metadata("design:returntype", Promise)
], CoachController.prototype, "getClientSummary", null);
__decorate([
    (0, common_1.Get)('my-guidelines'),
    __param(0, (0, common_1.Request)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], CoachController.prototype, "getMyGuidelines", null);
__decorate([
    (0, common_1.Get)('guidelines/:client_id'),
    __param(0, (0, common_1.Request)()),
    __param(1, (0, common_1.Param)('client_id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], CoachController.prototype, "getGuidelines", null);
__decorate([
    (0, common_1.Post)('guidelines/:client_id'),
    __param(0, (0, common_1.Request)()),
    __param(1, (0, common_1.Param)('client_id')),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", Promise)
], CoachController.prototype, "postGuidelines", null);
__decorate([
    (0, common_1.Get)('alerts'),
    __param(0, (0, common_1.Request)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], CoachController.prototype, "getAlerts", null);
exports.CoachController = CoachController = __decorate([
    (0, common_1.Controller)('coach'),
    (0, common_1.UseGuards)(auth_guard_1.JwtAuthGuard, coach_guard_1.CoachGuard),
    __metadata("design:paramtypes", [coach_service_1.CoachService])
], CoachController);
//# sourceMappingURL=coach.controller.js.map