import { Global, Module } from '@nestjs/common';
import { WearablesCloudConnectorsGuard } from './cloud-connectors.feature';

/**
 * P0-0B — DI scope for {@link WearablesCloudConnectorsGuard}.
 *
 * The cloud-connectors kill-switch guard is mounted via `@UseGuards(...)` on
 * the OAuth-start endpoint (`ConnectionsController.startOauth`) and on all
 * eight provider webhook controllers. NestJS only resolves a class-scoped /
 * method-scoped guard if that class is available as a provider in the DI scope
 * of the module that owns the controller. Decorating without registering can
 * leave the route unguarded (or fail at runtime).
 *
 * This module mirrors the repo's `SecurityGuardsModule` pattern
 * (`src/common/security/security-guards.module.ts`): it is `@Global()`, so any
 * module — `ConnectionsModule` and each of the eight connector modules — can
 * resolve the guard in `@UseGuards(...)` without importing this module
 * explicitly. It is imported once from `WearablesModule`.
 *
 * The guard itself has zero feature-module dependencies (it only reads
 * `process.env`), so a global provider here carries no module-cycle risk and
 * keeps a single source of truth for the kill-switch's DI registration.
 */
@Global()
@Module({
  providers: [WearablesCloudConnectorsGuard],
  exports: [WearablesCloudConnectorsGuard],
})
export class WearablesCloudConnectorsGuardModule {}
