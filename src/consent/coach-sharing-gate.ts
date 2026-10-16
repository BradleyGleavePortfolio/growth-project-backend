import { WearableMetricType } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { ConsentScope, ConsentService } from './consent.service';

/** The ids, out of `clientIds`, whose `scope` log the coach may read. */
export type CoachSharingCheck = (scope: string, clientIds: string[]) => Promise<string[]>;

/**
 * COACH-AI-GATE-130 — which clients' `scope` logs a coach-side reader of many clients or of AI input may
 * read. Same rule as the client summary, in one batch: ConsentService.grantedScopesByClient (workouts, food
 * logs and weigh-ins: the client's coach now; Check-ins and habits: that switch; the owner passes).
 * `consent` is missing only in hand-built unit tests (the services take it without @Optional(), so
 * Nest fails at boot rather than run without it); those keep their all-shared fixtures.
 */
export async function coachSharingCheck(
  consent: ConsentService | undefined,
  prisma: PrismaService,
  coachId: string,
): Promise<CoachSharingCheck> {
  if (!consent) return async (_scope, clientIds) => clientIds;
  const caller = await prisma.user.findUnique({ where: { id: coachId }, select: { role: true } });
  return async (scope, clientIds) => {
    const granted = await consent.grantedScopesByClient(coachId, clientIds, [scope], caller?.role);
    return clientIds.filter((id) => granted.get(id)?.has(scope) === true);
  };
}

/** The fields that hold a weight on a row a coach read sends: a check-in's, and the profile's current and target. */
const WEIGHT_FIELDS = ['weight_kg', 'current_weight_lbs', 'target_weight_lbs'] as const;

/**
 * C8-S (SoT A2 item 12): a coach-facing read returns a client's weight only to a coach who may read
 * weigh-ins (`fitness.body_metrics`, ConsentService.coachCanAccess: the client's coach now). Otherwise
 * each weight field reads null, the shape an unshared slice already has (roster and summary
 * `profile: null`); the rest of the row stays.
 */
export function weightIfShared<T extends object>(row: T, weighIns: boolean): T {
  if (weighIns) return row;
  return { ...row, ...Object.fromEntries(WEIGHT_FIELDS.filter((f) => f in row).map((f) => [f, null])) };
}

/** The device samples that are a weight: body weight and body fat (wearables, Health Connect, HealthKit). */
export const WEIGHT_METRICS: readonly WearableMetricType[] = [WearableMetricType.BODY_WEIGHT_KG, WearableMetricType.BODY_FAT_PCT];

/**
 * WEIGHTWALL (SoT A2 item 12): the one "can this caller see this client's weight" check. Yes for the
 * client themselves; a coach only while they coach that client now
 * (ConsentService.coachCanAccess, `fitness.body_metrics`; the owner account passes). No means no
 * weight, no body fat and no number computed from them, from any source, except the calorie and
 * macro targets the app works out (owner ww-targets op 2: those stay on Macros and in the AI drafts).
 */
export async function seesWeight(
  consent: ConsentService | undefined,
  callerId: string,
  clientId: string,
  callerRole?: string,
): Promise<boolean> {
  if (callerId === clientId || !consent) return true;
  return consent.coachCanAccess(callerId, clientId, ConsentScope.FITNESS_BODY_METRICS, callerRole);
}
