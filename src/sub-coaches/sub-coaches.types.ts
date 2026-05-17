// Phase 8 — shared types and constants for the sub-coaches surface.
// Pulled out of sub-coaches.service.ts during the split so the
// invite / analytics / main services share one definition without
// importing each other.

export const SUB_COACH_HEAD_CAP = 2;
export const INVITE_TTL_DAYS = 14;
export const TIER_MAX_CLIENTS: Record<string, number> = {
  growth: 30,
  pro: 150,
  enterprise: 500,
};
export const DEFAULT_MAX_CLIENTS = 30;

export interface SubCoachSummaryView {
  id: string;
  name: string;
  email: string;
  created_at: Date;
  coach_profile: {
    plan_tier: string;
    business_name: string | null;
  } | null;
  capacity: {
    subCoachId: string;
    assignedClients: number;
    maxClients: number;
    planTier: string;
    hasCapacity: boolean;
  };
  engagement: {
    subCoachId: string;
    score: number;
    breakdown: {
      logged_in_within_7d: number;
      messaged_within_48h_of_checkin: number;
      updated_workout_plan_this_week: number;
      avg_workout_completion_gte_70: number;
    };
  };
}

export interface SubCoachDetailView extends SubCoachSummaryView {
  clients: Array<{
    id: string;
    name: string;
    email: string;
    created_at: Date;
    archived_at: Date | null;
  }>;
  coach_profile: {
    plan_tier: string;
    business_name: string | null;
    bio: string | null;
  } | null;
}

export interface InviteResult {
  inviteId: string;
  email: string;
  inviteUrl: string;
  expires_at: string;
}

export interface RevokeResult {
  ok: true;
  reassignedClientCount: number;
}

export interface ReassignResult {
  clientId: string;
  previousCoachId: string | null;
  newCoachId: string;
  auditLogId: string;
}

// Public-shape preview of a SubCoachInvite. Returned by the unauthenticated
// preview endpoint so the mobile deep-link landing screen can render
// "{head coach name} invited you to join their team" without forcing the
// user through auth first.
export interface InvitePreviewView {
  inviteId: string;
  email: string;
  name: string | null;
  max_clients: number | null;
  expires_at: string;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  head_coach: {
    id: string;
    name: string;
    business_name: string | null;
  };
}

// Result of POST /sub-coaches/invites/accept. `already_accepted` is true
// on the idempotent re-call path (same caller already accepted) so the
// mobile UI can avoid double-toasting.
export interface AcceptInviteResult {
  ok: true;
  inviteId: string;
  assignmentId: string;
  headCoachId: string;
  subCoachId: string;
  already_accepted: boolean;
}
