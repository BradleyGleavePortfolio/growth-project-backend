import { Injectable } from '@nestjs/common';

// Module-level readiness flag for the Connect surface.
//
// Set to `ready: true` only by ConnectModule.onModuleInit when:
//   1. STRIPE_SECRET_KEY is set and looks like a Stripe key (sk_test_* / sk_live_*).
//   2. The Stripe Connect platform probe (GET /v1/accounts?limit=1) returned 2xx.
//
// Set to `ready: false` with a human-readable `reason` otherwise. The
// controller short-circuits every endpoint with 503 + the reason — which
// implements the "real or flagged, never fake" gate at the route level.
@Injectable()
export class ConnectModuleState {
  ready = false;
  reason: string | null = null;
}
