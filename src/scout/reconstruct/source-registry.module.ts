import { Module } from '@nestjs/common';
import {
  NO_RUN_PACKAGE,
  RUN_PACKAGE_SOURCE,
  SourceRegistryProvider,
} from './source-registry.provider';

/**
 * L2a — provides the ONE {@link SourceRegistryProvider} (D-L0-5) to every module whose services
 * resolve source families: `ScoutModule` (engine, lifecycle, roster and entities readers),
 * `ReconciliationModule` (facts) and `ObservationModule` (induction routes and its lifecycle).
 * Nest instantiates an imported module once, so they all share one provider over one loaded
 * file set.
 *
 * r2 (R588-A-B1, R588-B-2): the `RUN_PACKAGE_SOURCE` binding lives HERE, inside the module whose
 * provider injects it — a binding placed in an importing module is invisible to this one. Until
 * L2b it is explicitly {@link NO_RUN_PACKAGE} (every run resolves to the file registries); L2b
 * replaces this provider (the pinned learned package read on the caller's transaction) in this
 * module, and tests override the token (`overrideProvider(RUN_PACKAGE_SOURCE)`). The token is
 * required by the provider, and the provider is required by every consumer: a missing binding
 * fails Nest boot rather than silently reading no pin.
 */
@Module({
  providers: [{ provide: RUN_PACKAGE_SOURCE, useValue: NO_RUN_PACKAGE }, SourceRegistryProvider],
  exports: [SourceRegistryProvider],
})
export class SourceRegistryModule {}
