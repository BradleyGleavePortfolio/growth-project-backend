"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FastingModule = void 0;
const common_1 = require("@nestjs/common");
const fasting_controller_1 = require("./fasting.controller");
const fasting_service_1 = require("./fasting.service");
const prisma_service_1 = require("../prisma.service");
const auth_module_1 = require("../auth/auth.module");
let FastingModule = class FastingModule {
};
exports.FastingModule = FastingModule;
exports.FastingModule = FastingModule = __decorate([
    (0, common_1.Module)({ imports: [auth_module_1.AuthModule], controllers: [fasting_controller_1.FastingController], providers: [fasting_service_1.FastingService, prisma_service_1.PrismaService] })
], FastingModule);
//# sourceMappingURL=fasting.module.js.map