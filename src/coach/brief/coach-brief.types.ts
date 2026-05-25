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
// client PII. Monetary values are in cents (integer). Head-coach mode
// uses BriefContextHeadCoach instead (business-only — see P1-3).
export interface BriefContext {
  brief_mode: 'solo_coach' | 'sub_coach';
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

// Head-coach context. P1-3 / CPO ruling: head-coach mode is BUSINESS
// METRICS ONLY — never client-level data. Sub-coaches handle the
// individual client work; the head coach gets a COO view of the team.
// We intentionally do NOT extend BriefContext because that interface
// carries solo client-level counts (workouts_pending_approval,
// unread_messages, etc.). A head coach should never see a client name
// or client_id in their brief; that's what the sub-coach brief is for.
export interface BriefContextHeadCoach {
  brief_mode: 'head_coach';
  date: string;
  coach_name: string;
  coach_first_name: string;

  team_size: number;
  team_clients_total: number;
  active_clients: number;
  new_clients_last_24h: number;

  total_revenue_today_cents: number;
  team_revenue_30d_cents: number;
  mrr_projected_cents: number;
  paid_today_count: number;

  dunning_in_progress: number;
  dunning_amount_cents: number;

  sub_coach_highlights: SubCoachHighlight[];
}

export type ActionItemType =
  | 'workout_approval'
  | 'checkin_missing'
  | 'payment_due'
  | 'weight_flag'
  | 'message_unread'
  // P1-3 head-coach-only business action types. They never carry a
  // client_id — see HeadCoachActionItem.
  | 'team_revenue_review'
  | 'dunning_queue'
  | 'team_performance'
  | 'sub_coach_operations';

// Deterministic — NOT AI-generated. Built from aggregated rows then
// sorted ascending by priority. client_id / client_name are required
// for solo + sub-coach modes; head-coach business actions use
// HeadCoachActionItem instead and never carry client identifiers.
export interface ActionItem {
  type: ActionItemType;
  client_id: string;
  client_name: string;
  detail: string;
  priority: 1 | 2 | 3;
  deep_link: string;
}

// P1-3: head-coach mode emits business-only action items. No client_id,
// no client_name. The mobile renders these as KPI tiles rather than
// individual client rows.
export interface HeadCoachActionItem {
  type:
    | 'team_revenue_review'
    | 'dunning_queue'
    | 'team_performance'
    | 'sub_coach_operations';
  detail: string;
  priority: 1 | 2 | 3;
  deep_link: string;
}

export interface BriefSummary {
  date: string;
  brief_mode: BriefMode;
  narrative: string;
  brief_context: BriefContext | BriefContextHeadCoach;
  // Solo + sub-coach briefs use ActionItem[]; head-coach briefs use
  // HeadCoachActionItem[] (no client identifiers — see P1-3 / CPO
  // ruling). Mobile branches on brief_mode to render the correct shape.
  action_items: ActionItem[] | HeadCoachActionItem[];
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
