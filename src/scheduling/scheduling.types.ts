// Shared types and module-private helpers for the scheduling surface.
// Extracted from scheduling.service.ts during the M9 refactor so the
// lifecycle / open-slots / availability / facade services share one set
// of definitions without importing each other.

export interface ActorContext {
  id: string;
  role: 'student' | 'coach' | 'owner';
  email: string | null;
  coach_id: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export interface OpenSlotsPayload {
  coach_id: string;
  timezone: string;
  generated_at: string;
  slots: { start_at: string; end_at: string }[];
}

export function dateOnly(d: Date, dayDelta: number): Date {
  const r = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  r.setUTCDate(r.getUTCDate() + dayDelta);
  return r;
}

export function minutesToHHMM(min: number | null): string | null {
  if (min === null) return null;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}
