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
  async createForClient(coachId: string, clientId: string, dto: CreateMealPlanDto) {
    await this.assertClientOfCoach(coachId, clientId);
    return this.prisma.mealPlan.create({
      data: {
        coach_id: coachId,
        client_id: clientId,
        title: dto.title,
        notes: dto.notes ?? null,
        items: dto.items as unknown as object,
      },
    });
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
