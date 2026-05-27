**Architectural Refactor Priorities — Repository Pattern, Fat Controller, High-CCN Decomposition**

*Filed verbatim from third-party architectural review. Findings are ordered by structural impact and effort.*

🔴 D — Direct Prisma Coupling (81% of services)

The problem in one sentence: Every service talks directly to the database — if you rename a column, 122 files could break.

The fix — Repository Pattern (incremental, not a rewrite):

Don't fix all 122 at once. Prioritize the 5 most-touched domains first:

Create a thin repository class per domain:

```typescript
// src/users/user.repository.ts
@Injectable()
export class UserRepository {
  constructor(private readonly prisma: PrismaService) {}

  findById(id: string) {
    return this.prisma.user.findUnique({ where: { id } });
  }
  findClientsByCoach(coachId: string) {
    return this.prisma.user.findMany({
      where: { coach_id: coachId, role: 'student', deleted_at: null }
    });
  }
}
```

Services inject UserRepository, not PrismaService

When you change the schema, you change one file (the repository), not 50

Priority order: UserRepository → CheckInRepository → PtmRepository → CoachMessageRepository → ClientPurchaseRepository. These five cover the most cross-cutting queries. The AI agent can generate all five in one sprint — give it the instruction: "Extract all Prisma queries scoped to the User model across all service files into a single UserRepository class."

🟠 C — Fat Controller (checkout/payment-ops.controller.ts, 18 imports)

The problem: Controllers should only do: auth, parse request, call one service, return response. 18 imports means it's doing orchestration logic it shouldn't be.

The fix — extract a CheckoutOrchestratorService:

```typescript
// Bad: Controller directly imports StripeService, PackageService,
//      EntitlementService, WebhookService, AuditService...

// Good: Controller imports ONE service
@Controller('checkout')
export class PaymentOpsController {
  constructor(private readonly checkout: CheckoutOrchestratorService) {}

  @Post('intent')
  createIntent(@Body() dto, @Req() req) {
    return this.checkout.createPaymentIntent(req.user.id, dto);
  }
}
```

Move all the multi-service coordination into CheckoutOrchestratorService. The controller drops from 18 imports to 3–4 (the orchestrator + guards + DTOs). This also makes the checkout flow unit-testable without spinning up the full HTTP layer.

🟡 B- — The Two CCN >50 Functions (build CCN 72, anonymous billing CCN 61)

The problem: These are your two functions a new developer (or you, in 6 months) would genuinely struggle to modify safely.

The fix — Decompose by responsibility:

client-context.service.ts:build assembles AI context by conditionally gathering ~15 different data types. It should be a pipeline of small builders:

```typescript
// Instead of one 145-line function with 72 branches:
async build(clientId: string): Promise<AIContext> {
  return {
    identity:    await this.buildIdentity(clientId),
    fitness:     await this.buildFitnessProfile(clientId),
    nutrition:   await this.buildNutritionContext(clientId),
    checkins:    await this.buildRecentCheckIns(clientId),
    goals:       await this.buildGoals(clientId),
    riskSignals: await this.buildRiskSignals(clientId),
  };
}
```

Each build* method is 10–20 lines, has CCN ≤5, and can be tested in isolation. The top-level build() drops to CCN ~3 (one await per field, no branching).

For the anonymous billing callback — give it a name and extract its switch/if chains into a BillingEventRouter with one method per event type (handleSubscriptionCreated, handlePaymentFailed, etc.).

TL;DR Priority Order

| Fix | Effort | Impact |
|---|---|---|
| Extract UserRepository (start here) | 1 day AI sprint | Prevents future schema debt |
| Extract CheckoutOrchestratorService | 2–3 hours | Makes checkout testable |
| Decompose client-context.service.ts:build | 1–2 hours | Removes your highest-risk function |
| Extend repositories to 4 other domains | 1 day AI sprint | Structural D → B |

None of these require touching existing tests — they're structural refactors that preserve all existing behaviour. The AI agent can execute all of them from a clear instruction, which is exactly where it's strongest.
