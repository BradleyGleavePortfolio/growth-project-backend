import { Injectable } from '@nestjs/common';

/**
 * GymDistributionService — STUB
 *
 * Gym round-robin and weighted distribution for PT assignment.
 * Schema scaffold is in prisma/migrations/gym_distribution_scaffold.md
 *
 * TODO: implement after GymProfile + CoachDistributionWeight are added to schema
 * and migrations are run.
 *
 * Distribution modes:
 *   ROUND_ROBIN — cycles evenly through active PTs in order
 *   WEIGHTED    — assigns based on weight_bps targets; uses "furthest-below-target"
 *                 algorithm to prevent drift over time
 *
 * Head coach configures via PATCH /gym/distribution
 * Clients join via deep link: growthproject.app/join/:slug
 */
@Injectable()
export class GymDistributionService {
  // assignCoach(gymId: string): Promise<string> — returns assigned coach_id
  // updateDistribution(gymId: string, mode: DistributionMode, weights?: {coach_id:string, weight_bps:number}[]): Promise<void>
  // validateWeights(weights: {weight_bps:number}[]): void — throws if sum !== 10000
}
