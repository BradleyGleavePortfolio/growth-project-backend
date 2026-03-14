"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WeightModule = void 0;
const common_1 = require("@nestjs/common");
const weight_controller_1 = require("./weight.controller");
const weight_service_1 = require("./weight.service");
const prisma_service_1 = require("../prisma.service");
const auth_module_1 = require("../auth/auth.module");
let WeightModule = class WeightModule {
};
exports.WeightModule = WeightModule;
exports.WeightModule = WeightModule = __decorate([
    (0, common_1.Module)({ imports: [auth_module_1.AuthModule], controllers: [weight_controller_1.WeightController], providers: [weight_service_1.WeightService, prisma_service_1.PrismaService] })
], WeightModule);
//# sourceMappingURL=weight.module.js.map