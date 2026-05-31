import { Module } from '@nestjs/common';
import { OauthStateService } from './oauth-state.service';

/**
 * PR-HK-1 — OAuth support module for wearable connections.
 *
 * Provides {@link OauthStateService} — the CSRF state + PKCE issuer/consumer
 * used by the generic connect/callback flow. Kept as its own module (rather
 * than folding into ConnectionsModule) so connector PRs (PR-HK-2.*) and any
 * future OAuth-adjacent service can import the state service without pulling
 * in the connections controller.
 *
 * The PKCE helpers live in `pkce.util.ts` as a dependency-free utility and are
 * imported directly where needed — no provider, by design (pure functions).
 */
@Module({
  providers: [OauthStateService],
  exports: [OauthStateService],
})
export class OauthModule {}
