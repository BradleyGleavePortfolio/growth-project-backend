// H6 — audit_log substrate types (D-H6-1 / D-H6-5 LOCKED 2026-06-26).
//
// These types describe a single structured audit row written through
// AuditLogService.withAuditLog() in the same database transaction as the
// PII mutation it records. They are intentionally narrow: the column set
// mirrors the 13-column audit_log table exactly (D-H6-1), and the JSON
// state fields are typed loosely because they are polymorphic across every
// resource type the platform mutates.

import { Prisma } from '@prisma/client';

// The four actor classes recognised by the substrate. Free-form strings are
// still accepted at the column level (text), but call sites should use one
// of these so dashboards can group cleanly.
export type ActorType = 'user' | 'coach' | 'system' | 'admin';

// Canonical audit actions. 'create' | 'update' | 'delete' | 'read' are the
// CRUD verbs the ESLint rule keys on; a custom string is also accepted for
// domain-specific events (e.g. 'scrub', 'sign_in', 'charge').
export type AuditAction = 'create' | 'update' | 'delete' | 'read' | (string & {});

// The resource the action touched. PascalCase model name where one exists
// ('User', 'Coach', 'Message', 'CheckIn', 'CoachPackage', ...), else a
// free-form domain label.
export type ResourceType = string;

// A redactable JSON snapshot. R98 forbids raw PII in these columns — every
// write goes through redactPii() (see erasure-token.ts) before it reaches
// the database.
export type AuditState = Record<string, unknown> | null | undefined;

// The context an audit call site supplies. tenant_id is mandatory (RLS
// tier 1 / R125); everything else is optional and defaults to null at the
// column level.
export interface AuditLogContext {
  // Tenant scope — REQUIRED. Maps to audit_log.tenant_id (NOT NULL).
  tenantId: string;
  // The principal that performed the action. NULL for system/cron actors.
  actorId?: string | null;
  actorType: ActorType | string;
  // The verb. Use a CRUD verb where possible so the ESLint rule and
  // dashboards stay consistent.
  action: AuditAction;
  // The resource touched.
  resourceType: ResourceType;
  resourceId?: string | null;
  // Before / after snapshots. Redacted before write (R98).
  beforeState?: AuditState;
  afterState?: AuditState;
  // Optional free-text reason. Per D-H6-1 the column ships nullable.
  reason?: string | null;
  // Correlation id for tracing a request across services.
  requestId?: string | null;
  // Caller IP. Redactable via erasure token for GDPR Art. 17.
  ipAddress?: string | null;
}

// The function the caller wants to run inside the audited transaction. It
// receives the same transaction client the audit row is written with, so a
// caller can pass `tx` straight through to its prisma writes and have the
// mutation + the audit row commit or roll back together (D-H6-5).
export type AuditedFn<T> = (tx: Prisma.TransactionClient) => Promise<T>;
