/**
 * Verifies that the canonical PostHog events defined in src/analytics/events.ts
 * are emitted by the right call sites. We don't exercise the PostHog client —
 * just that AnalyticsService.capture() is invoked with the documented event
 * name + the right (non-PII) properties. If somebody renames an event or
 * silently drops a capture call this test catches it.
 */
import { Events } from '../src/analytics/events';
import { BillingService } from '../src/billing/billing.service';
import { MessagingService } from '../src/messaging/messaging.service';
import { LogService } from '../src/log/log.service';
import { AiService } from '../src/ai/ai.service';
import { AIGuardrailsService } from '../src/ai/ai-guardrails.service';
import { ClientAIContextService } from '../src/ai/client-ai-context.service';
import type { ClientAIContext } from '../src/ai/client-ai-context.types';

const makeAnalytics = () => ({ capture: jest.fn(), identify: jest.fn() });

const PII_KEYS = [
  'email',
  'password',
  'name',
  'full_name',
  'phone',
  'phone_number',
  'address',
];

function assertNoPII(props: Record<string, unknown> | undefined) {
  if (!props) return;
  for (const key of Object.keys(props)) {
    expect(PII_KEYS).not.toContain(key.toLowerCase());
  }
}

describe('analytics instrumentation — billing webhook lifecycle', () => {
  function buildBilling(analytics = makeAnalytics()) {
    const profile = { user_id: 'coach-1', stripe_customer_id: 'cus_1' };
    const prisma: any = {
      coachProfile: { findFirst: jest.fn(async () => profile) },
      coachSubscription: {
        upsert: jest.fn(async () => ({})),
        update: jest.fn(async () => ({})),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
      invoice: {
        upsert: jest.fn(async () => ({})),
      },
      paymentFailure: {
        create: jest.fn(async () => ({})),
      },
      stripeProcessedEvent: {
        findUnique: jest.fn(async () => null),
        create: jest.fn(async () => ({})),
      },
    };
    return { svc: new BillingService(prisma, analytics as any, { write: jest.fn(async () => {}), list: jest.fn(async () => []) } as any), prisma, analytics };
  }

  it('emits subscription_updated on customer.subscription.created', async () => {
    const { svc, analytics } = buildBilling();
    await svc.handleEvent({
      id: 'evt_1',
      type: 'customer.subscription.created',
      data: {
        object: {
          id: 'sub_1',
          customer: 'cus_1',
          status: 'active',
          current_period_end: 1700000000,
          cancel_at_period_end: false,
          items: { data: [{ price: { id: 'price_1' } }] },
        },
      },
    });
    expect(analytics.capture).toHaveBeenCalledWith(
      'coach-1',
      Events.SUBSCRIPTION_UPDATED,
      expect.objectContaining({ status: 'active', stripe_price_id: 'price_1' }),
    );
    assertNoPII((analytics.capture.mock.calls[0]?.[2] ?? {}) as any);
  });

  it('emits subscription_canceled on customer.subscription.deleted', async () => {
    const { svc, analytics } = buildBilling();
    await svc.handleEvent({
      id: 'evt_2',
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_1', customer: 'cus_1' } },
    });
    expect(analytics.capture).toHaveBeenCalledWith(
      'coach-1',
      Events.SUBSCRIPTION_CANCELED,
      expect.any(Object),
    );
  });

  it('emits invoice_paid with Stripe-sourced amounts only (no synthetic revenue)', async () => {
    const { svc, analytics } = buildBilling();
    await svc.handleEvent({
      id: 'evt_3',
      type: 'invoice.paid',
      data: {
        object: {
          id: 'in_1',
          customer: 'cus_1',
          amount_paid: 30000,
          amount_due: 30000,
          currency: 'usd',
          status: 'paid',
          status_transitions: { paid_at: 1700000000 },
        },
      },
    });
    const call = analytics.capture.mock.calls.find(
      (c: any) => c[1] === Events.INVOICE_PAID,
    );
    expect(call).toBeDefined();
    expect(call[2]).toMatchObject({ amount_paid_cents: 30000, currency: 'usd' });
  });

  it('emits invoice_payment_failed on payment failures', async () => {
    const { svc, analytics } = buildBilling();
    await svc.handleEvent({
      id: 'evt_4',
      type: 'invoice.payment_failed',
      data: {
        object: { id: 'in_2', customer: 'cus_1', amount_due: 30000 },
      },
    });
    expect(analytics.capture).toHaveBeenCalledWith(
      'coach-1',
      Events.INVOICE_PAYMENT_FAILED,
      expect.objectContaining({ amount_due_cents: 30000 }),
    );
  });
});

describe('analytics instrumentation — messaging', () => {
  function buildMessaging(analytics = makeAnalytics()) {
    const messages: any[] = [];
    const users: Record<string, any> = {
      'coach-1': { id: 'coach-1', role: 'coach', coach_id: null },
      'client-1': { id: 'client-1', role: 'student', coach_id: 'coach-1' },
    };
    const prisma: any = {
      user: {
        findFirst: jest.fn(async ({ where }: any) => {
          if (where.coach_id) {
            return users[where.id]?.coach_id === where.coach_id ? users[where.id] : null;
          }
          return users[where.id] ?? null;
        }),
        findUnique: jest.fn(async ({ where }: any) => users[where.id] ?? null),
      },
      coachMessage: {
        create: jest.fn(async ({ data }: any) => {
          const row = { id: 'm-' + (messages.length + 1), ...data, created_at: new Date() };
          messages.push(row);
          return row;
        }),
      },
    };
    const supabase: any = { broadcastNewMessage: jest.fn() };
    return { svc: new MessagingService(prisma, supabase, analytics as any), analytics };
  }

  it('emits coach_message_sent when coach sends', async () => {
    const { svc, analytics } = buildMessaging();
    await svc.sendAsCoach('coach-1', 'client-1', 'hi');
    expect(analytics.capture).toHaveBeenCalledWith(
      'coach-1',
      Events.COACH_MESSAGE_SENT,
      expect.objectContaining({ client_id: 'client-1', body_length: 2 }),
    );
  });

  it('emits client_message_sent when client sends', async () => {
    const { svc, analytics } = buildMessaging();
    await svc.sendAsClient('client-1', 'hello back');
    expect(analytics.capture).toHaveBeenCalledWith(
      'client-1',
      Events.CLIENT_MESSAGE_SENT,
      expect.objectContaining({ coach_id: 'coach-1' }),
    );
  });
});

describe('analytics instrumentation — log service', () => {
  it('emits client_food_logged on logFood', async () => {
    const analytics = makeAnalytics();
    const prisma: any = {
      loggedFoodEntry: {
        create: jest.fn(async ({ data }: any) => ({ id: 'l1', ...data })),
      },
    };
    const food: any = { resolveOrImportId: jest.fn(async () => 'fi-1') };
    const svc = new LogService(prisma, food, analytics as any);
    await svc.logFood('user-1', {
      food_item_id: 'fi-1',
      date: '2026-04-27',
      meal_type: 'breakfast' as any,
      quantity_multiplier: 1,
    } as any);
    expect(analytics.capture).toHaveBeenCalledWith(
      'user-1',
      Events.CLIENT_FOOD_LOGGED,
      expect.objectContaining({ meal_type: 'breakfast' }),
    );
  });
});

describe('analytics instrumentation — AI chat', () => {
  it('emits ai_chat_invoked with model_used set to fallback when no API key', async () => {
    const ctx: ClientAIContext = {
      identity: { user_id: 'u1', first_name: 'Alex' },
      profile: {
        goal_type: 'fat_loss',
        current_weight_lbs: 180,
        target_weight_lbs: 170,
        height_cm: 180,
        workout_experience: 'intermediate',
        has_gym_membership: true,
        preferred_snacks: [],
        dietary_pattern: null,
        dietary_restrictions: [],
        workout_days_per_week: null,
        activity_level: 'moderate',
      },
      prescribed: { calories: 2000, protein_g: 180, carbs_g: 200, fat_g: 60, water_ml: null },
      today: {
        calories: 0,
        protein_g: 0,
        carbs_g: 0,
        fat_g: 0,
        pct_calories: 0,
        remaining_calories: 2000,
        remaining_protein_g: 180,
      },
      coach: {
        has_coach: false,
        coach_id: null,
        coach_name: null,
        last_coach_message_excerpt: null,
      },
      guardrails: { forbid_calorie_recommendations_below: 1500 },
      generated_at: new Date().toISOString(),
    } as any;
    const ctxSvc = {
      build: jest.fn(async () => ctx),
      renderForPrompt: jest.fn(() => 'CTX'),
    } as any;
    const analytics = makeAnalytics();
    const prevKey = process.env.PERPLEXITY_API_KEY;
    delete process.env.PERPLEXITY_API_KEY;
    const svc = new AiService(
      {} as any,
      ctxSvc as ClientAIContextService,
      new AIGuardrailsService(),
      analytics as any,
    );
    await svc.chat('user-1', 'how am I doing today', []);
    process.env.PERPLEXITY_API_KEY = prevKey;
    expect(analytics.capture).toHaveBeenCalledWith(
      'user-1',
      Events.AI_CHAT_INVOKED,
      expect.objectContaining({ model_used: 'fallback', has_coach: false }),
    );
  });
});
