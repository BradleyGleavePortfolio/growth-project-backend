// SlotComputerService — pure functions that materialize recurring
// availability windows into concrete UTC slot ranges, then subtract
// overrides (HOLIDAY/BLOCK) and existing active sessions, and finally
// add EXTRA-override-only windows.
//
// Intentionally has no Nest decorators, no DB access, and no
// dependencies. Every input is a plain object; every output is a
// plain object. This makes the unit tests trivial (no fakes, no
// mocks) and the function deterministic.
//
// All times in/out at the API boundary are UTC ISO strings. The coach
// timezone only matters to interpret CoachAvailability rows
// (day_of_week + start_minute/end_minute live in the coach's local
// clock). DST is handled by recomputing the tz offset at each local
// midnight in the requested range.

export interface AvailabilityWindow {
  day_of_week: number; // 0=Sun..6=Sat
  start_minute: number; // minutes from local midnight
  end_minute: number;
}

export interface AvailabilityOverride {
  // YYYY-MM-DD in coach local tz.
  date: string;
  // minutes from local midnight; null means full-day (only valid for holiday/block).
  start_minute: number | null;
  end_minute: number | null;
  kind: 'holiday' | 'block' | 'extra';
}

export interface SessionInterval {
  start_at: Date;
  end_at: Date;
}

export interface ComputeInput {
  from: Date; // UTC
  to: Date; // UTC
  durationMinutes: number;
  coachTimezone: string;
  windows: AvailabilityWindow[];
  overrides: AvailabilityOverride[];
  bookings: SessionInterval[];
}

export interface ComputedSlot {
  start_at: string; // ISO UTC
  end_at: string; // ISO UTC
}

export interface RangeError {
  code: 'BAD_RANGE' | 'RANGE_TOO_LARGE';
  message: string;
}

const MAX_RANGE_DAYS = 14;

export function validateRange(
  from: Date,
  to: Date,
): RangeError | null {
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return { code: 'BAD_RANGE', message: 'from and to must be valid ISO timestamps' };
  }
  if (from.getTime() >= to.getTime()) {
    return { code: 'BAD_RANGE', message: 'from must be strictly before to' };
  }
  const spanMs = to.getTime() - from.getTime();
  const spanDays = spanMs / (1000 * 60 * 60 * 24);
  if (spanDays > MAX_RANGE_DAYS) {
    return {
      code: 'RANGE_TOO_LARGE',
      message: `range must be ${MAX_RANGE_DAYS} days or less`,
    };
  }
  return null;
}

// Returns the y/m/d/h/m/s of `instant` projected into `tz`. Used to
// determine "what local date and minute-of-day is this UTC instant in
// the coach's timezone". Uses Intl.DateTimeFormat parts so DST is
// honored without needing tzdata in the app.
function localPartsInTz(
  instant: Date,
  tz: string,
): { year: number; month: number; day: number; weekday: number; minuteOfDay: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    weekday: 'short',
  });
  const parts = fmt.formatToParts(instant);
  const byType: Record<string, string> = {};
  for (const p of parts) byType[p.type] = p.value;
  const weekdayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  const hour = Number(byType.hour === '24' ? '0' : byType.hour);
  const minute = Number(byType.minute);
  return {
    year: Number(byType.year),
    month: Number(byType.month),
    day: Number(byType.day),
    weekday: weekdayMap[byType.weekday] ?? 0,
    minuteOfDay: hour * 60 + minute,
  };
}

// Inverse of localPartsInTz: take a year/month/day + minuteOfDay in
// the named tz, return the UTC instant. Handles DST by binary
// converging on the offset (handles the "spring forward" gap and
// "fall back" overlap deterministically — picks the later of two
// valid interpretations during overlap, the simple forward step
// during gap).
function utcFromLocal(
  year: number,
  month: number, // 1-12
  day: number,
  minuteOfDay: number,
  tz: string,
): Date {
  // First-pass guess: assume the UTC clock matches the local clock.
  const guess = new Date(Date.UTC(year, month - 1, day, Math.floor(minuteOfDay / 60), minuteOfDay % 60));
  // What does that UTC instant project to in `tz`?
  const projected = localPartsInTz(guess, tz);
  const projectedMin =
    (Date.UTC(projected.year, projected.month - 1, projected.day) +
      projected.minuteOfDay * 60_000) /
    60_000;
  const wantedMin =
    (Date.UTC(year, month - 1, day) + minuteOfDay * 60_000) / 60_000;
  // Offset in minutes between guess-as-tz and what we wanted.
  const offsetMin = projectedMin - wantedMin;
  return new Date(guess.getTime() - offsetMin * 60_000);
}

function addDays(d: Date, days: number): Date {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + days);
  return r;
}

function ymdString(year: number, month: number, day: number): string {
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
}

interface MinuteRange {
  startMin: number; // minutes since UTC epoch
  endMin: number;
}

// Subtract `holes` from `solid`. Returns merged, sorted remaining
// pieces. Assumes pieces are already sorted by start and may overlap
// in `holes`.
function subtractRanges(solid: MinuteRange[], holes: MinuteRange[]): MinuteRange[] {
  if (!holes.length) return solid.slice();
  // Merge holes first.
  const merged: MinuteRange[] = [];
  const sortedHoles = holes.slice().sort((a, b) => a.startMin - b.startMin);
  for (const h of sortedHoles) {
    const last = merged[merged.length - 1];
    if (last && h.startMin <= last.endMin) {
      last.endMin = Math.max(last.endMin, h.endMin);
    } else {
      merged.push({ startMin: h.startMin, endMin: h.endMin });
    }
  }
  const out: MinuteRange[] = [];
  for (const s of solid) {
    let pieces: MinuteRange[] = [{ startMin: s.startMin, endMin: s.endMin }];
    for (const h of merged) {
      const next: MinuteRange[] = [];
      for (const p of pieces) {
        if (h.endMin <= p.startMin || h.startMin >= p.endMin) {
          next.push(p);
          continue;
        }
        if (h.startMin > p.startMin) next.push({ startMin: p.startMin, endMin: h.startMin });
        if (h.endMin < p.endMin) next.push({ startMin: h.endMin, endMin: p.endMin });
      }
      pieces = next;
      if (!pieces.length) break;
    }
    out.push(...pieces);
  }
  return out;
}

// Chop a range into consecutive slots of `duration` minutes,
// discarding any tail shorter than one full slot.
function sliceIntoSlots(r: MinuteRange, durationMin: number): MinuteRange[] {
  const out: MinuteRange[] = [];
  let cursor = r.startMin;
  while (cursor + durationMin <= r.endMin) {
    out.push({ startMin: cursor, endMin: cursor + durationMin });
    cursor += durationMin;
  }
  return out;
}

export function computeOpenSlots(input: ComputeInput): ComputedSlot[] {
  const { from, to, durationMinutes, coachTimezone, windows, overrides, bookings } = input;
  if (durationMinutes <= 0) return [];

  // Determine the local date range to walk. We expand by ±1 day on
  // each side to catch windows that span midnight in tz vs UTC.
  const fromLocal = localPartsInTz(from, coachTimezone);
  const toLocal = localPartsInTz(to, coachTimezone);
  const startDay = new Date(Date.UTC(fromLocal.year, fromLocal.month - 1, fromLocal.day));
  const endDay = new Date(Date.UTC(toLocal.year, toLocal.month - 1, toLocal.day));
  const dayCount = Math.round((endDay.getTime() - startDay.getTime()) / (1000 * 60 * 60 * 24)) + 1;

  const overridesByDate = new Map<string, AvailabilityOverride[]>();
  for (const o of overrides) {
    const list = overridesByDate.get(o.date) ?? [];
    list.push(o);
    overridesByDate.set(o.date, list);
  }

  // Build the available minute ranges (in UTC-minutes) day by day.
  const solid: MinuteRange[] = [];
  for (let i = 0; i < dayCount; i++) {
    const date = addDays(startDay, i);
    const y = date.getUTCFullYear();
    const m = date.getUTCMonth() + 1;
    const d = date.getUTCDate();
    const dateKey = ymdString(y, m, d);
    const dayOverrides = overridesByDate.get(dateKey) ?? [];
    const isHoliday = dayOverrides.some(
      (o) => o.kind === 'holiday' && o.start_minute === null,
    );
    const fullDayBlocks = dayOverrides.filter(
      (o) => o.kind === 'block' && o.start_minute === null,
    );
    if (isHoliday || fullDayBlocks.length > 0) {
      // Whole day off — only EXTRA can put it back.
      const extras = dayOverrides.filter((o) => o.kind === 'extra');
      for (const e of extras) {
        if (e.start_minute === null || e.end_minute === null) continue;
        const startUtc = utcFromLocal(y, m, d, e.start_minute, coachTimezone);
        const endUtc = utcFromLocal(y, m, d, e.end_minute, coachTimezone);
        solid.push({ startMin: startUtc.getTime() / 60_000, endMin: endUtc.getTime() / 60_000 });
      }
      continue;
    }

    // 1. Recurring windows matching this weekday.
    const weekdayProbe = utcFromLocal(y, m, d, 0, coachTimezone);
    const probeWeekday = localPartsInTz(weekdayProbe, coachTimezone).weekday;
    const dayWindows = windows.filter((w) => w.day_of_week === probeWeekday);
    const daySolid: MinuteRange[] = [];
    for (const w of dayWindows) {
      const startUtc = utcFromLocal(y, m, d, w.start_minute, coachTimezone);
      const endUtc = utcFromLocal(y, m, d, w.end_minute, coachTimezone);
      daySolid.push({ startMin: startUtc.getTime() / 60_000, endMin: endUtc.getTime() / 60_000 });
    }
    // 2. Add EXTRA overrides.
    for (const e of dayOverrides.filter((o) => o.kind === 'extra')) {
      if (e.start_minute === null || e.end_minute === null) continue;
      const startUtc = utcFromLocal(y, m, d, e.start_minute, coachTimezone);
      const endUtc = utcFromLocal(y, m, d, e.end_minute, coachTimezone);
      daySolid.push({ startMin: startUtc.getTime() / 60_000, endMin: endUtc.getTime() / 60_000 });
    }
    // 3. Subtract partial HOLIDAY/BLOCK overrides.
    const partialHoles: MinuteRange[] = [];
    for (const o of dayOverrides.filter(
      (x) => (x.kind === 'holiday' || x.kind === 'block') && x.start_minute !== null,
    )) {
      if (o.start_minute === null || o.end_minute === null) continue;
      const startUtc = utcFromLocal(y, m, d, o.start_minute, coachTimezone);
      const endUtc = utcFromLocal(y, m, d, o.end_minute, coachTimezone);
      partialHoles.push({ startMin: startUtc.getTime() / 60_000, endMin: endUtc.getTime() / 60_000 });
    }
    const dayResult = subtractRanges(daySolid, partialHoles);
    solid.push(...dayResult);
  }

  // Subtract bookings.
  const bookingHoles: MinuteRange[] = bookings.map((b) => ({
    startMin: b.start_at.getTime() / 60_000,
    endMin: b.end_at.getTime() / 60_000,
  }));
  const afterBookings = subtractRanges(solid, bookingHoles);

  // Clip to the requested [from, to] range.
  const fromMin = from.getTime() / 60_000;
  const toMin = to.getTime() / 60_000;
  const clipped: MinuteRange[] = [];
  for (const r of afterBookings) {
    const s = Math.max(r.startMin, fromMin);
    const e = Math.min(r.endMin, toMin);
    if (e - s >= durationMinutes) clipped.push({ startMin: s, endMin: e });
  }

  // Slice into discrete duration-sized slots.
  const sliced: MinuteRange[] = [];
  for (const r of clipped) sliced.push(...sliceIntoSlots(r, durationMinutes));

  // Sort + dedupe.
  sliced.sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  const out: ComputedSlot[] = [];
  let prevStart = -1;
  for (const s of sliced) {
    if (s.startMin === prevStart) continue;
    prevStart = s.startMin;
    out.push({
      start_at: new Date(s.startMin * 60_000).toISOString(),
      end_at: new Date(s.endMin * 60_000).toISOString(),
    });
  }
  return out;
}
