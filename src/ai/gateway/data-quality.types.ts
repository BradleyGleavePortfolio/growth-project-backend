// Shared data-quality + provenance contracts. These mirror the finance
// app's PR #112 contracts so the two backends can interoperate without
// duplicating types. Everything here is pure types/enums — no runtime
// behavior — so the contract can evolve in lock-step with finance.

// Validation status of a single field or record. `verified_external`
// means a third party (bank feed, lab result, coach signoff) confirmed
// the value; `claimed_user` is self-reported and unverified.
export type ValidationStatus =
  | 'unvalidated'
  | 'claimed_user'
  | 'verified_external'
  | 'verified_coach'
  | 'rejected';

// Confidence the AI / system has in a value or claim. Surfaced to the
// user when an AI output is shown (e.g. "low confidence — flag to
// coach"). AI never produces `verified` — only humans do.
export type ConfidenceLevel = 'low' | 'medium' | 'high' | 'verified';

// Why a value should be treated with suspicion. `stale` and
// `missing_source` are the two flags every consumer must respect; the
// rest are provenance-side annotations.
export interface DataQualityFlags {
  stale: boolean;
  missing_source: boolean;
  validation_status: ValidationStatus;
  confidence: ConfidenceLevel;
  abuse_suspected?: boolean;
  // Free-form short reason for ops review. Never shown to clients.
  reason?: string;
}

// Single retrieval reference. The gateway audit row stores an array of
// these so a reviewer can see exactly which records the AI was given,
// without persisting the records themselves. `hash` is sha256 of the
// canonicalized record JSON; `count` is the number of items pulled
// from that source.
export interface ProvenanceRef {
  source: string; // e.g. "user_profile", "logged_food_entries", "coach_messages"
  ref?: string;   // optional row id when a single record drove the call
  hash?: string;  // sha256 of canonicalized JSON if a payload was used
  count: number;  // number of items retrieved from this source
  // If the data source is the finance app or any cross-tenant
  // federation, mark the origin so reviewers can trace cross-app
  // provenance back to the right system of record.
  origin?: 'local' | 'finance' | 'external';
}

// Proof-of-claim contract used when the AI cites a number that came
// from outside this backend (e.g. "your finance app shows $X cleared").
// Must align with finance PR #112 — fields here are required there
// too. Backend defines the SHAPE; finance owns the payload.
export interface ProofClaim {
  source: string;
  source_ref?: string;
  asserted_at: string; // ISO 8601
  validation_status: ValidationStatus;
  confidence: ConfidenceLevel;
  // True when the claim was approved by a human (coach or owner)
  // before being shown to the client. AI-generated claims must NEVER
  // be marked human_signed_off=true at creation; only the approval
  // workflow flips it.
  human_signed_off: boolean;
  // Sub-systems that contributed evidence. Free-form list — the
  // finance app uses the same vocabulary in PR #112.
  evidence_refs?: ProvenanceRef[];
}

// Hook contract: a sub-system that wants to feed proof / provenance
// into the gateway audit row implements this. The gateway calls it
// with the resolved tenant scope; the implementation returns 0..n
// references. Intentionally synchronous-async-flexible (Promise) so
// the finance app's federation client can fulfill it over HTTP.
export interface ProofHook {
  readonly source: string;
  fetchRefs(scope: { subjectUserId?: string; tenantCoachId?: string }): Promise<ProvenanceRef[]>;
}
