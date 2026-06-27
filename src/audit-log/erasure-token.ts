// H6 — GDPR Art. 17 erasure + R98 PII-redaction helpers (D-H6-4 LOCKED).
//
// Two responsibilities live here:
//
//   1. redactPii(ctx) — the write-path guard. Every audit row's
//      before_state / after_state passes through this before it hits the
//      database, stripping the well-known raw-PII keys (email, phone,
//      password, tokens, card data, raw lab values, ...) so the audit_log
//      table never durably stores R98-forbidden plaintext. It is
//      deliberately conservative: it redacts on a deny-list of key-name
//      patterns and leaves IDs and non-PII fields intact so the row stays
//      forensically useful.
//
//   2. ERASURE_TOKEN + redactRowForErasure(row) — the on-demand GDPR Art.
//      17 path. The retention rotation script never deletes audit rows
//      (D-H6-4: archive, never delete). When a user exercises right-to-be-
//      forgotten, the GDPR scrub service calls redactRowForErasure() to
//      overwrite the PII columns (actor_id, ip_address, before_state,
//      after_state) IN PLACE with the erasure token, leaving the row's
//      existence, action, resource_type, and timestamps intact so the
//      compliance trail (that something happened, when) survives.

import type { AuditLogContext } from './audit-log.types';

// The sentinel written into a redacted PII field. Distinct, greppable, and
// obviously not real data.
export const ERASURE_TOKEN = '[REDACTED:GDPR-ART-17]' as const;

// Key-name fragments that mark a value as raw PII for R98 purposes. Matched
// case-insensitively against the LAST path segment of each key. Start
// narrow; widen only when an actual leak is found (D-H6-3 ESLint rule keeps
// new write paths honest).
const PII_KEY_PATTERNS: readonly string[] = [
  'email',
  'phone',
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'api_key',
  'authorization',
  'ssn',
  'taxid',
  'tax_id',
  'card',
  'cardnumber',
  'card_number',
  'cvv',
  'cvc',
  'iban',
  'bankaccount',
  'bank_account',
  'routing',
  'address',
  'dob',
  'date_of_birth',
  'birthdate',
  'lab_value',
  'labvalue',
  'result_value',
  'bloodwork',
];

function isPiiKey(key: string): boolean {
  const k = key.toLowerCase();
  return PII_KEY_PATTERNS.some((pat) => k === pat || k.endsWith(pat) || k.includes(pat));
}

// Recursively redact PII-keyed leaves in a state object. Non-PII keys and
// their values pass through. Arrays and nested objects are walked. Caps
// recursion depth defensively so a pathological cyclic-ish structure cannot
// stall the write path.
function redactState(value: unknown, depth = 0): unknown {
  if (value == null || depth > 8) return value;
  if (Array.isArray(value)) {
    return value.map((v) => redactState(v, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isPiiKey(k) ? ERASURE_TOKEN : redactState(v, depth + 1);
    }
    return out;
  }
  return value;
}

// The shape AuditLogService writes. Mirrors the audit_log column names.
export interface RedactedAuditRow {
  tenant_id: string;
  actor_id: string | null;
  actor_type: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
  reason: string | null;
  request_id: string | null;
  ip_address: string | null;
}

// Write-path guard (R98). Maps an AuditLogContext to the column-shaped row
// the service inserts, redacting raw PII from before/after state on the way.
export function redactPii(ctx: AuditLogContext): RedactedAuditRow {
  return {
    tenant_id: ctx.tenantId,
    actor_id: ctx.actorId ?? null,
    actor_type: ctx.actorType,
    action: ctx.action,
    resource_type: ctx.resourceType,
    resource_id: ctx.resourceId ?? null,
    before_state: redactState(ctx.beforeState ?? null) as Record<string, unknown> | null,
    after_state: redactState(ctx.afterState ?? null) as Record<string, unknown> | null,
    reason: ctx.reason ?? null,
    request_id: ctx.requestId ?? null,
    ip_address: ctx.ipAddress ?? null,
  };
}

// On-demand GDPR Art. 17 in-place redaction. Returns the column patch the
// caller applies to an existing audit row to erase its PII while preserving
// the audit fact (existence + action + resource_type + timestamps). Note:
// because audit_log REVOKEs UPDATE from app_runtime (D-H6-1), this patch is
// applied by the privileged erasure path, not the normal runtime role.
export function redactRowForErasure(): {
  actor_id: null;
  ip_address: string;
  before_state: Record<string, string>;
  after_state: Record<string, string>;
} {
  return {
    actor_id: null,
    ip_address: ERASURE_TOKEN,
    before_state: { _erased: ERASURE_TOKEN },
    after_state: { _erased: ERASURE_TOKEN },
  };
}
