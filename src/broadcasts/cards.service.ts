import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { broadcastError } from './broadcast-errors';
import type { CoachScope } from './broadcast-scope.service';

/**
 * Rich message cards. A card is a typed reference into the sending coach's
 * own library plus a display snapshot captured when it is attached:
 *
 *   workout   -> WorkoutPlan      (tenant or author, not archived)
 *   meal_plan -> MealPlan         (tenant or author, not archived; a plan
 *                                  that belongs to one client can only go
 *                                  to that client, never to a group)
 *   booking   -> SessionType      (tenant or author, not archived)
 *   package   -> CoachPackage     (tenant or author, active, not archived)
 *   check_in  -> no reference     (a prompt that opens the client's check-in)
 *
 * The server resolves every reference itself; a client-supplied snapshot is
 * never accepted, and a reference outside the tenant answers card.ref_not_found
 * (no cross-tenant links, no existence oracle).
 */
export const CARD_TYPES = ['workout', 'meal_plan', 'booking', 'package', 'check_in'] as const;
export type CardType = (typeof CARD_TYPES)[number];

export interface CardSpec {
  type: CardType;
  ref_id?: string;
  /** Optional coach line shown on the card (check_in prompt, etc.). */
  note?: string;
}

export interface ResolvedCard {
  type: CardType;
  ref_id: string | null;
  snapshot: Record<string, string | number | boolean | null>;
}

const ID_RE = /^[0-9a-fA-F-]{8,64}$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function parseCardSpec(input: unknown): CardSpec {
  const bad = (reason: string) => broadcastError('card.invalid', { reason });
  if (!isPlainObject(input)) throw bad('not_an_object');
  for (const k of Object.keys(input))
    if (!['type', 'ref_id', 'note'].includes(k)) throw bad(`unknown_field:${k}`);
  const type = input.type;
  if (typeof type !== 'string' || !(CARD_TYPES as readonly string[]).includes(type))
    throw bad('type');
  const spec: CardSpec = { type: type as CardType };
  if (type === 'check_in') {
    if (input.ref_id !== undefined) throw bad('check_in_has_no_ref');
  } else {
    if (typeof input.ref_id !== 'string' || !ID_RE.test(input.ref_id)) throw bad('ref_id');
    spec.ref_id = input.ref_id;
  }
  if (input.note !== undefined) {
    if (typeof input.note !== 'string') throw bad('note');
    const note = input.note.trim();
    if (note.length > 200) throw bad('note_length');
    if (note.length > 0) spec.note = note;
  }
  return spec;
}

/** Narrow a stored JSON value back to a ResolvedCard (defensive read). */
export function readStoredCard(v: Prisma.JsonValue | null): ResolvedCard | null {
  if (!isPlainObject(v)) return null;
  const type = v.type;
  if (typeof type !== 'string' || !(CARD_TYPES as readonly string[]).includes(type)) return null;
  const snapshot = isPlainObject(v.snapshot) ? v.snapshot : {};
  const clean: Record<string, string | number | boolean | null> = {};
  for (const [k, val] of Object.entries(snapshot)) {
    if (val === null || ['string', 'number', 'boolean'].includes(typeof val)) {
      clean[k] = val as string | number | boolean | null;
    }
  }
  return {
    type: type as CardType,
    ref_id: typeof v.ref_id === 'string' ? v.ref_id : null,
    snapshot: clean,
  };
}

@Injectable()
export class CardsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolve and validate a card for `scope`. `audience` is 'group' for
   * broadcasts and the client id for a 1:1 send.
   */
  async resolve(
    scope: CoachScope,
    spec: CardSpec,
    audience: 'group' | { clientId: string },
  ): Promise<ResolvedCard> {
    const owners = [...new Set([scope.tenantId, scope.actorId])];
    const note = spec.note ?? null;
    const notFound = () => broadcastError('card.ref_not_found', { type: spec.type });
    switch (spec.type) {
      case 'check_in':
        return { type: 'check_in', ref_id: null, snapshot: { title: 'Check-in', note } };
      case 'workout': {
        const p = await this.prisma.workoutPlan.findFirst({
          where: { id: spec.ref_id, coach_id: { in: owners }, archived_at: null },
          select: { id: true, name: true, type: true, duration_estimate_minutes: true },
        });
        if (!p) throw notFound();
        return {
          type: 'workout',
          ref_id: p.id,
          snapshot: {
            title: p.name,
            plan_type: String(p.type),
            duration_minutes: p.duration_estimate_minutes ?? null,
            note,
          },
        };
      }
      case 'meal_plan': {
        const m = await this.prisma.mealPlan.findFirst({
          where: { id: spec.ref_id, coach_id: { in: owners }, archived_at: null },
          select: { id: true, title: true, client_id: true },
        });
        if (!m) throw notFound();
        if (m.client_id) {
          if (audience === 'group') throw broadcastError('card.meal_plan_client_specific');
          if (m.client_id !== audience.clientId) throw notFound();
        }
        return { type: 'meal_plan', ref_id: m.id, snapshot: { title: m.title, note } };
      }
      case 'booking': {
        const s = await this.prisma.sessionType.findFirst({
          where: { id: spec.ref_id, coach_id: { in: owners }, archived_at: null },
          select: { id: true, name: true, duration_minutes: true },
        });
        if (!s) throw notFound();
        return {
          type: 'booking',
          ref_id: s.id,
          snapshot: { title: s.name, duration_minutes: s.duration_minutes, note },
        };
      }
      case 'package': {
        const k = await this.prisma.coachPackage.findFirst({
          where: { id: spec.ref_id, coach_id: { in: owners }, is_active: true, archived_at: null },
          select: {
            id: true,
            name: true,
            amount_cents: true,
            currency: true,
            billing_type: true,
            interval: true,
            interval_count: true,
          },
        });
        if (!k) throw notFound();
        return {
          type: 'package',
          ref_id: k.id,
          snapshot: {
            title: k.name,
            amount_cents: k.amount_cents,
            currency: k.currency,
            billing_type: k.billing_type,
            interval: k.interval ?? null,
            interval_count: k.interval_count,
            note,
          },
        };
      }
    }
  }
}
