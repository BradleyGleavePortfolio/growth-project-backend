// Local-time rendering for notification copy (B-643-1).
//
// Every time a notification shows must be in the recipient's own time
// zone, with the zone named ("5:30 PM PDT"), and never in UTC. When no
// usable zone is known, callers drop the clock time and use relative
// copy instead ("in about an hour"), so a client never acts on a time
// in the wrong zone.
//
// Pure functions only: no I/O, no Date.now() unless the caller omits `now`.

// Zone names that mean "UTC". The mobile app's device-zone helpers fall
// back to 'UTC' when Intl is unavailable, so a stored 'UTC' says "unknown",
// not "this person lives on UTC". Treated as no zone.
const UTC_ALIASES = new Set([
  'UTC',
  'UCT',
  'ZULU',
  'UNIVERSAL',
  'GMT',
  'GMT0',
  'GMT+0',
  'GMT-0',
  'GREENWICH',
  'ETC/UTC',
  'ETC/UCT',
  'ETC/ZULU',
  'ETC/UNIVERSAL',
  'ETC/GMT',
  'ETC/GMT0',
  'ETC/GMT+0',
  'ETC/GMT-0',
  'ETC/GREENWICH',
]);

/** A valid IANA zone that is not a UTC alias, or null. */
export function usableTimeZone(tz: unknown): string | null {
  if (typeof tz !== 'string') return null;
  const t = tz.trim();
  if (t.length === 0 || t.length > 64) return null;
  if (UTC_ALIASES.has(t.toUpperCase())) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: t });
    return t;
  } catch {
    return null;
  }
}

// ICU may separate "5:30" and "PM" with a narrow no-break space; push
// lock screens and the inbox render a plain space more predictably.
function clean(s: string): string {
  return s.replace(/[\u202f\u00a0]/g, ' ');
}

/** "5:30 PM PDT" in `tz`. */
export function formatClock(d: Date, tz: string): string {
  return clean(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(d),
  );
}

/** Calendar date of `d` in `tz` as a UTC-midnight day number. */
function localDayNumber(d: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(d);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Math.round(Date.UTC(get('year'), get('month') - 1, get('day')) / 86_400_000);
}

/**
 * "today", "tomorrow", "on Wednesday" (within the next week) or
 * "on Jun 9", for `target` as seen from `now`, both in `tz`.
 */
export function dayLabel(target: Date, tz: string, now: Date = new Date()): string {
  const diff = localDayNumber(target, tz) - localDayNumber(now, tz);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff > 1 && diff < 7) {
    return `on ${new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(target)}`;
  }
  return `on ${clean(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric' }).format(
      target,
    ),
  )}`;
}

/** "Tue, Jun 2 at 8:30 AM PDT" in `tz`. */
export function formatDateTime(d: Date, tz: string): string {
  const date = clean(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    }).format(d),
  );
  return `${date} at ${formatClock(d, tz)}`;
}
