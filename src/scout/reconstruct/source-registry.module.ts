import { Module } from '@nestjs/common';
import { SourceRegistryProvider } from './source-registry.provider';

/**
 * L2a — provides the ONE {@link SourceRegistryProvider} (D-L0-5) to every module whose services
 * resolve source families: `ScoutModule` (engine, roster and entities readers),
 * `ReconciliationModule` (facts) and `ObservationModule` (induction routes). Nest instantiates an
 * imported module once, so the three share one provider over one loaded file set. A
 * `RUN_PACKAGE_SOURCE` provider (L2b: the pinned learned package read from PostgreSQL) plugs in
 * beside this module; until then every run resolves to the file registries.
 */
@Module({
  providers: [SourceRegistryProvider],
  exports: [SourceRegistryProvider],
})
export class SourceRegistryModule {}
