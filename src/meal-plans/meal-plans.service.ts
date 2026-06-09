import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import type { CreateMealPlanDto, UpdateMealPlanDto } from './meal-plans.dto';

@Injectable()
export class MealPlansService {
  constructor(private prisma: PrismaService) {}

  // Verify a client belongs to this coach. 404 on missing / foreign — the
  // existence of another coach's client must not leak (same 404-not-403
  // convention as NudgesService / MessagingService).
  private async assertClientOfCoach(coachId: string, clientId: string) {
    const client = await this.prisma.user.findFirst({
      where: { id: clientId, coach_id: coachId, role: 'student' },
      select: { id: true },
    });
    if (!client) throw new NotFoundException('Client not found');
    return client;
  }

  // ---- coach-side CRUD ----

  // Coach creates a plan for one of their clients. `items` is stored as JSON
  // exactly as validated — we intentionally don't normalize further so the
  // mobile client can round-trip optional fields that a newer schema adds.
  // When `days` is provided (AI-generated plans), it is stored alongside
  // `items` so mobile can render meals grouped by day.
  async createForClient(coachId: string, clientId: string, dto: CreateMealPlanDto) {
    await this.assertClientOfCoach(coachId, clientId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = {
      coach_id: coachId,
      client_id: clientId,
      title: dto.title,
      notes: dto.notes ?? null,
      items: dto.items as unknown as object,
    };
    // H2 fix: persist per-day structure for AI-generated plans. The `days`
    // column is added by migration 20260605000000_add_meal_plan_days_json;
    // cast through `any` until `prisma generate` picks up the new field.
    if (dto.days !== undefined) {
      data.days = dto.days;
    }
    return this.prisma.mealPlan.create({ data });
  }

  // Coach's plans for a specific client, newest first, excluding archived.
  // Composite (coach_id, client_id, created_at) index makes this a single seek.
  async listForClientByCoach(coachId: string, clientId: string) {
    await this.assertClientOfCoach(coachId, clientId);
    return this.prisma.mealPlan.findMany({
      where: { coach_id: coachId, client_id: clientId, archived_at: null },
      orderBy: { created_at: 'desc' },
    });
  }

  // Coach updates a plan. Must belong to *this* coach — 404 if missing or
  // owned by a different coach. Already-archived plans are not editable;
  // returning 404 in that case is intentional so callers can't probe for
  // archived ids.
  async updateByCoach(coachId: string, planId: string, dto: UpdateMealPlanDto) {
    const existing = await this.prisma.mealPlan.findFirst({
      where: { id: planId, coach_id: coachId, archived_at: null },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Meal plan not found');

    const data: {
      title?: string;
      notes?: string | null;
      items?: object;
    } = {};
    if (dto.title !== undefined) data.title = dto.title;
    if (dto.notes !== undefined) data.notes = dto.notes;
    if (dto.items !== undefined) data.items = dto.items as unknown as object;

    return this.prisma.mealPlan.update({
      where: { id: planId },
      data,
    });
  }

  // Soft-archive (spec §A.2). Idempotent in the sense that a double call
  // returns 404 on the second call (record is then already archived) — the
  // 404 mirrors the update path above and is what the mobile client expects.
  async archiveByCoach(coachId: string, planId: string) {
    const result = await this.prisma.mealPlan.updateMany({
      where: { id: planId, coach_id: coachId, archived_at: null },
      data: { archived_at: new Date() },
    });
    if (result.count === 0) throw new NotFoundException('Meal plan not found');
    return { archived: result.count };
  }

  // ---- client-side reads ----

  // Client reads their own active plans (newest first). Index on client_id
  // backs this; archived_at filter excludes soft-deleted.
  async listForClient(clientId: string) {
    return this.prisma.mealPlan.findMany({
      where: { client_id: clientId, archived_at: null },
      orderBy: { created_at: 'desc' },
    });
  }

  // ---- BUG-R2 deprecation wrapper ----
  //
  // `real-meal-plans` is the CANONICAL meal-plan system (DailyMealPlan +
  // MealTemplate + DailyMealPlanAssignment). This legacy `MealPlan` table is
  // being kept alive only until every mobile client has migrated off the
  // `GET /meal-plans` surface (see MealPlansModule removal note).
  //
  // The bug: a coach who builds a plan via the newer `coach/daily-meal-plans`
  // API writes to `DailyMealPlan`, but a client still on the old app calls
  // `GET /meal-plans`, which reads ONLY the legacy `MealPlan` table and
  // returns nothing — so the client sees "no meal plan assigned" even though
  // a real plan exists. This wrapper closes that gap by ALSO surfacing the
  // client's most-recently-assigned canonical plan, reshaped into the legacy
  // `MealPlan` response shape, so old clients see real data.
  //
  // Behaviour contract (deliberately additive — no change for callers that
  // work today): genuine legacy `MealPlan` rows are returned exactly as
  // before. The reshaped canonical plan is merged into the same newest-first
  // list keyed on `created_at`/assignment recency, so a client with only a
  // canonical plan now gets it, and a client with both sees both.
  async listForClientWithCanonicalFallback(clientId: string) {
    const legacy = await this.listForClient(clientId);
    const canonical = await this.mostRecentCanonicalAsLegacyShape(clientId);
    if (!canonical) return legacy;
    // Merge newest-first. `created_at` is the comparable key across both
    // shapes (the canonical entry carries its assignment's effective date).
    const merged = [...legacy, canonical].sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
    return merged;
  }

  // Query the canonical system for the client's most-recently-assigned,
  // currently-or-previously-effective DailyMealPlan and reshape ONE plan
  // into the legacy `MealPlan` response shape. Returns null when the client
  // has no canonical assignment, so the caller can fall through to legacy.
  //
  // SECURITY: scoped strictly by `client_id` — we never trust a caller to
  // hand us a plan/assignment id. The assignment row is the ownership proof
  // (a coach can only create one for their own client), so reading by
  // `client_id` cannot leak another client's plan.
  private async mostRecentCanonicalAsLegacyShape(clientId: string) {
    const assignment = await this.prisma.dailyMealPlanAssignment.findFirst({
      where: { client_id: clientId },
      // Most recently assigned wins: order by effective start, then by the
      // row's own creation so two same-day assignments are still ordered.
      orderBy: [{ starts_on: 'desc' }, { created_at: 'desc' }],
      include: {
        daily_meal_plan: {
          include: {
            slots: {
              orderBy: [{ slot_label: 'asc' }, { order: 'asc' }],
              include: { meal_template: true },
            },
          },
        },
      },
    });
    if (!assignment || !assignment.daily_meal_plan) return null;
    const plan = assignment.daily_meal_plan;
    if (plan.archived_at) return null;

    // Each canonical slot → one legacy `items[]` entry. `slot_label` maps to
    // the legacy free-form `time_of_day`; the template macros map onto the
    // legacy optional calorie/protein fields.
    const items = (plan.slots ?? []).map(
      (s: {
        slot_label: string;
        meal_template: {
          name: string;
          description: string | null;
          calories_kcal: number;
          protein_g: number;
        };
      }) => ({
        name: s.meal_template.name,
        calories: s.meal_template.calories_kcal,
        protein: s.meal_template.protein_g,
        notes: s.meal_template.description ?? undefined,
        time_of_day: s.slot_label,
      }),
    );

    // Reshape into the legacy `MealPlan` shape. `id` is namespaced so a
    // client can tell this entry came from the canonical system and so it
    // can never collide with a real legacy row id (and a client cannot use
    // it against `GET /meal-plans/:id`, which only reads the legacy table).
    return {
      id: `canonical:${plan.id}`,
      coach_id: plan.coach_id,
      client_id: clientId,
      title: plan.name,
      notes: plan.notes ?? null,
      items,
      days: null,
      // Surface the assignment's effective date as `created_at` so the merge
      // ordering reflects when the client actually received this plan.
      created_at: assignment.starts_on,
      updated_at: plan.created_at,
      archived_at: null,
      // Marker so analytics / clients can distinguish a reshaped canonical
      // plan from a genuine legacy row without parsing the id prefix.
      source: 'real-meal-plans' as const,
    };
  }

  // Client reads a single plan. 404 if not found OR not theirs — foreign
  // ownership must return the same 404 as genuinely missing so callers can't
  // probe. Archived plans are hidden from clients (they're soft-deleted).
  async getOneForClient(clientId: string, planId: string) {
    const plan = await this.prisma.mealPlan.findFirst({
      where: { id: planId, client_id: clientId, archived_at: null },
    });
    if (!plan) throw new NotFoundException('Meal plan not found');
    return plan;
  }
}
