import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { bucketize } from '../ptm/ptm.types';
import { broadcastError } from './broadcast-errors';
import type { CoachScope } from './broadcast-scope.service';
import { combineRuleSets, type Segment, type SegmentRule } from './segment';

const DAY_MS = 86_400_000;

export interface ResolvedAudience {
  /** Clients who will receive the broadcast. */
  recipientIds: string[];
  /** Matched the segment but a block (either direction) excludes them. */
  blockedIds: string[];
  rosterSize: number;
}

/**
 * Evaluates a Segment inside the caller's roster. Every rule query is
 * bounded to `scope.clientIds`, and package / program references are
 * checked against the tenant first, so a forged id from another coach
 * returns broadcast.segment_ref_not_found instead of leaking a count.
 */
@Injectable()
export class SegmentResolverService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(
    scope: CoachScope,
    segment: Segment,
    now: Date = new Date(),
  ): Promise<ResolvedAudience> {
    const roster = scope.clientIds;
    if (roster.length === 0) return { recipientIds: [], blockedIds: [], rosterSize: 0 };
    await this.assertRefsInTenant(scope, segment.rules);
    const sets: Array<Set<string>> = [];
    for (const rule of segment.rules) sets.push(await this.evaluate(scope, roster, rule, now));
    const matched = combineRuleSets(roster, segment.match, sets, segment.exclude_client_ids);
    const blocked = await this.blockedAmong(scope, matched);
    return {
      recipientIds: matched.filter((id) => !blocked.has(id)),
      blockedIds: matched.filter((id) => blocked.has(id)),
      rosterSize: roster.length,
    };
  }

  /** Clients in `ids` with a block in either direction with the author or the tenant coach. */
  async blockedAmong(scope: CoachScope, ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const coaches = [...new Set([scope.actorId, scope.tenantId])];
    const rows = await this.prisma.userBlock.findMany({
      where: {
        OR: [
          { blocker_id: { in: coaches }, blocked_id: { in: ids } },
          { blocker_id: { in: ids }, blocked_id: { in: coaches } },
        ],
      },
      select: { blocker_id: true, blocked_id: true },
    });
    const out = new Set<string>();
    for (const r of rows) out.add(coaches.includes(r.blocker_id) ? r.blocked_id : r.blocker_id);
    return out;
  }

  private async assertRefsInTenant(scope: CoachScope, rules: SegmentRule[]): Promise<void> {
    const owners = [...new Set([scope.tenantId, scope.actorId])];
    for (const rule of rules) {
      if (rule.field === 'package') {
        const n = await this.prisma.coachPackage.count({
          where: { id: { in: rule.values }, coach_id: { in: owners } },
        });
        if (n !== rule.values.length)
          throw broadcastError('broadcast.segment_ref_not_found', { field: 'package' });
      } else if (rule.field === 'program') {
        // B-728-1: only a master the caller can read in the program library
        // (their own, or shared with the team), as ProgramLibraryService does.
        const n = await this.prisma.workoutProgram.count({
          where: {
            id: { in: rule.values },
            coach_id: scope.tenantId,
            is_template: true,
            OR: [{ owner_user_id: scope.actorId }, { visibility: 'tenant_shared' }],
          },
        });
        if (n !== rule.values.length)
          throw broadcastError('broadcast.segment_ref_not_found', { field: 'program' });
      }
    }
  }

  private async evaluate(
    scope: CoachScope,
    roster: string[],
    rule: SegmentRule,
    now: Date,
  ): Promise<Set<string>> {
    switch (rule.field) {
      case 'package': {
        const rows = await this.prisma.clientPurchase.findMany({
          where: {
            client_user_id: { in: roster },
            package_id: { in: rule.values },
            entitlement_active: true,
          },
          select: { client_user_id: true },
          distinct: ['client_user_id'],
        });
        return new Set(rows.map((r) => r.client_user_id));
      }
      case 'program': {
        // B-727-1: assigning a master gives the client a live copy
        // (cloned_from_id = master) whose days carry the copy's id.
        const rows = await this.prisma.clientWorkoutAssignment.findMany({
          where: {
            client_id: { in: roster },
            workout_plan: {
              OR: [
                { program_id: { in: rule.values } },
                {
                  program: {
                    cloned_from_id: { in: rule.values },
                    is_template: false,
                    archived_at: null,
                    coach_id: scope.tenantId,
                  },
                },
              ],
            },
          },
          select: { client_id: true },
          distinct: ['client_id'],
        });
        return new Set(rows.map((r) => r.client_id));
      }
      case 'tag': {
        const rows = await this.prisma.coachClientTag.findMany({
          where: { coach_id: scope.tenantId, client_id: { in: roster }, tag: { in: rule.values } },
          select: { client_id: true },
          distinct: ['client_id'],
        });
        const tagged = new Set(rows.map((r) => r.client_id));
        return rule.op === 'in' ? tagged : new Set(roster.filter((id) => !tagged.has(id)));
      }
      case 'signup_date': {
        const cutoff = new Date(now.getTime() - rule.value * DAY_MS);
        const rows = await this.prisma.user.findMany({
          where: {
            id: { in: roster },
            created_at: rule.op === 'within_days' ? { gte: cutoff } : { lt: cutoff },
          },
          select: { id: true },
        });
        return new Set(rows.map((r) => r.id));
      }
      case 'last_active': {
        const cutoff = new Date(now.getTime() - rule.value * DAY_MS);
        const rows = await this.prisma.activityEvent.findMany({
          where: { client_id: { in: roster }, created_at: { gte: cutoff } },
          select: { client_id: true },
          distinct: ['client_id'],
        });
        const active = new Set(rows.map((r) => r.client_id).filter((x): x is string => !!x));
        return rule.op === 'within_days' ? active : new Set(roster.filter((id) => !active.has(id)));
      }
      case 'risk': {
        const latest = await this.prisma.ptmPrediction.groupBy({
          by: ['user_id'],
          where: { user_id: { in: roster } },
          _max: { computed_at: true },
        });
        const pairs = latest
          .filter((g) => g._max.computed_at)
          .map((g) => ({ user_id: g.user_id, computed_at: g._max.computed_at as Date }));
        const scores =
          pairs.length === 0
            ? []
            : await this.prisma.ptmPrediction.findMany({
                where: { OR: pairs },
                select: { user_id: true, risk_score: true },
              });
        const bucketOf = new Map<string, string>();
        for (const s of scores) bucketOf.set(s.user_id, bucketize(s.risk_score));
        const want = new Set<string>(rule.values);
        return new Set(roster.filter((id) => want.has(bucketOf.get(id) ?? 'unknown')));
      }
    }
  }
}
