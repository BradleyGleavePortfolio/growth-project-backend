// src/coach/brief/coach-brief.types.ts
//
// Typed contracts for the CoachBrief JSON columns and the HTTP responses
// emitted from the /coach/brief/* surface. These interfaces are the
// canonical shape — never cast `brief_context as any` and never read the
// JSON column without going through one of these types.

export type BriefMode = 'solo_coach' | 'head_coach' | 'sub_coach';

export type BriefStatus = 'pending' | 'generated' | 'failed';

export type BriefGeneratedBy = 'ai' | 'fallback';

// Base aggregated context for solo + sub-coach briefs. Numbers only; no
// client PII. Monetary values are in cents (integer).
export interface BriefContext {
  brief_mode: BriefMode;
  date: string;

  checked_in_today: number;
  missed_checkin: number;

  workouts_pending_approval: number;
  workouts_approved_today: number;

  paid_today_count: number;
  revenue_today_cents: number;
  renewals_upcoming_7d: number;
  dunning_in_progress: number;

  weight_logs_flagged: number;

  unread_messages: number;

  coach_name: string;
  coach_first_name: string;
  roster_size: number;
}

export interface SubCoachHighlight {
  coach_name: string;
  new_clients_24h: number;
  active_clients: number;
}

// Head-coach extension. Base BriefContext fields stay scoped to the head
// coach's OWN direct clients; the extra fields aggregate across the team.
export interface BriefContextHeadCoach extends BriefContext {
  brief_mode: 'head_coach';

  team_size: number;
  team_clients_total: number;

  total_revenue_today_cents: number;
  team_revenue_30d_cents: number;
  mrr_projected_cents: number;
  dunning_amount_cents: number;

  new_clients_last_24h: number;
  sub_coach_highlights: SubCoachHighlight[];
}

export type ActionItemType =
  | 'workout_approval'
  | 'checkin_missing'
  | 'payment_due'
  | 'weight_flag'
  | 'message_unread';

// Deterministic — NOT AI-generated. Built from aggregated rows then
// sorted ascending by priority.
export interface ActionItem {
  type: ActionItemType;
  client_id: string;
  client_name: string;
  detail: string;
  priority: 1 | 2 | 3;
  deep_link: string;
}

export interface BriefSummary {
  date: string;
  brief_mode: BriefMode;
  narrative: string;
  brief_context: BriefContext | BriefContextHeadCoach;
  action_items: ActionItem[];
  generated_by: BriefGeneratedBy;
}

export interface CoachBriefResponse {
  id: string;
  coach_id: string;
  brief_date: string;
  status: BriefStatus;
  brief_mode: BriefMode | null;
  generated_at: string | null;
  summary: BriefSummary | null;
  created_at: string;
}

export interface BriefHistoryResponse {
  items: CoachBriefResponse[];
  total: number;
  page: number;
  limit: number;
}

export interface CoachDailyLogResponse {
  id: string;
  coach_id: string;
  log_date: string;
  content: string;
  created_at: string;
  updated_at: string;
}

// Returned by GET /coach/brief/log/today when no log row exists yet.
// Mobile treats this as the initial state.
export interface EmptyDailyLogResponse {
  coach_id: string;
  log_date: string;
  content: '';
  exists: false;
}

export interface LogHistoryResponse {
  items: CoachDailyLogResponse[];
  total: number;
  page: number;
  limit: number;
}

export interface CoachBriefPreferencesResponse {
  coach_id: string;
  notification_time: string;
  timezone: string;
  enabled: boolean;
  created_at: string | null;
  updated_at: string | null;
}
