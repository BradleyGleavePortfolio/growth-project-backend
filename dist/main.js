"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("reflect-metadata");
const core_1 = require("@nestjs/core");
const common_1 = require("@nestjs/common");
const app_module_1 = require("./app.module");
const throttler_exception_filter_1 = require("./filters/throttler-exception.filter");
async function bootstrap() {
    const app = await core_1.NestFactory.create(app_module_1.AppModule);
    app.enableCors({
        origin: '*',
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization'],
    });
    app.useGlobalPipes(new common_1.ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
    }));
    app.useGlobalFilters(new throttler_exception_filter_1.ThrottlerExceptionFilter());
    app.setGlobalPrefix('api');
    const port = parseInt(process.env.PORT || '3000', 10);
    await app.listen(port, '0.0.0.0');
    console.log(`The Growth Project API running on port ${port}`);
}
bootstrap();
//# sourceMappingURL=main.js.map