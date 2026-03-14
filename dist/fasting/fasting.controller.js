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
exports.FastingController = void 0;
const common_1 = require("@nestjs/common");
const fasting_service_1 = require("./fasting.service");
const auth_guard_1 = require("../auth/auth.guard");
let FastingController = class FastingController {
    constructor(fastingService) {
        this.fastingService = fastingService;
    }
    async startFast(req, body) {
        return this.fastingService.startFast(req.user.id, body);
    }
    async endFast(req, body) {
        return this.fastingService.endFast(req.user.id, body.notes);
    }
    async getHistory(req, limit) {
        return this.fastingService.getHistory(req.user.id, limit ? parseInt(limit) : 10);
    }
};
exports.FastingController = FastingController;
__decorate([
    (0, common_1.Post)('start'),
    __param(0, (0, common_1.Request)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], FastingController.prototype, "startFast", null);
__decorate([
    (0, common_1.Post)('end'),
    __param(0, (0, common_1.Request)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], FastingController.prototype, "endFast", null);
__decorate([
    (0, common_1.Get)('history'),
    __param(0, (0, common_1.Request)()),
    __param(1, (0, common_1.Query)('limit')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], FastingController.prototype, "getHistory", null);
exports.FastingController = FastingController = __decorate([
    (0, common_1.Controller)('fasting'),
    (0, common_1.UseGuards)(auth_guard_1.JwtAuthGuard),
    __metadata("design:paramtypes", [fasting_service_1.FastingService])
], FastingController);
//# sourceMappingURL=fasting.controller.js.map