// Canonical state vocabulary for the bloodwork pipeline. Strings (not SQL
// enums) so the schema doesn't need a migration to add a state.

export const BloodworkReviewState = {
  DRAFT: 'draft',
  SUBMITTED: 'submitted',
  NEEDS_INFO: 'needs_info',
  REVIEWED: 'reviewed',
  FLAGGED: 'flagged',
  HIDDEN: 'hidden',
} as const;
export type BloodworkReviewStateValue =
  (typeof BloodworkReviewState)[keyof typeof BloodworkReviewState];

export const BloodworkScanStatus = {
  PENDING: 'pending_scan',
  CLEAN: 'clean',
  REJECTED: 'rejected',
  QUARANTINED: 'quarantined',
  UNAVAILABLE: 'unavailable',
} as const;
export type BloodworkScanStatusValue =
  (typeof BloodworkScanStatus)[keyof typeof BloodworkScanStatus];

export const BloodworkValidationStatus = {
  OK: 'ok',
  WARNINGS: 'warnings',
  ERRORS: 'errors',
} as const;

export const BloodworkSource = {
  MANUAL: 'manual_entry',
  LAB_PDF: 'lab_pdf',
  PHOTO: 'photo_self_report',
  EHR: 'ehr_import',
} as const;

export const BloodworkDisclaimerLevel = {
  EDUCATIONAL_ONLY: 'educational_only',
} as const;

export const BloodworkAuditAction = {
  PANEL_CREATED: 'bloodwork.panel_created',
  PANEL_UPDATED: 'bloodwork.panel_updated',
  PANEL_SUBMITTED: 'bloodwork.panel_submitted',
  PANEL_DELETED: 'bloodwork.panel_deleted',
  PANEL_REVIEWED: 'bloodwork.panel_reviewed',
  PANEL_FLAGGED: 'bloodwork.panel_flagged',
  PANEL_HIDDEN: 'bloodwork.panel_hidden',
  PANEL_NEEDS_INFO: 'bloodwork.panel_needs_info',
  PANEL_VISIBILITY_CHANGED: 'bloodwork.panel_visibility_changed',
  PANEL_MARKED_STALE: 'bloodwork.panel_marked_stale',
  RESULT_CREATED: 'bloodwork.result_created',
  RESULT_UPDATED: 'bloodwork.result_updated',
  RESULT_DELETED: 'bloodwork.result_deleted',
  ATTACHMENT_REGISTERED: 'bloodwork.attachment_registered',
  ATTACHMENT_SCAN_UPDATED: 'bloodwork.attachment_scan_updated',
} as const;

// Coach review state transitions allowed from each starting state. AI
// callers cannot transition to any of these — see assertActorCanReview.
export const COACH_TRANSITIONS: Record<string, ReadonlyArray<string>> = {
  draft: [], // coach cannot act on a draft
  submitted: ['reviewed', 'flagged', 'needs_info', 'hidden'],
  needs_info: ['reviewed', 'flagged', 'hidden'],
  reviewed: ['flagged', 'hidden', 'needs_info'],
  flagged: ['reviewed', 'hidden', 'needs_info'],
  hidden: ['reviewed', 'flagged'],
};

// Default freshness window. Panels older than this are eligible for the
// stale sweep. Configurable via env BLOODWORK_STALE_AFTER_DAYS.
export const DEFAULT_STALE_AFTER_DAYS = 365;
