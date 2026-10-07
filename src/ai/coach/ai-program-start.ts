// B-AIASSIGN-125: the day an approved AI workout program starts for the
// client. Day 1 of week 1 lands on the next Monday in the client's time zone
// (strictly after today), unless the draft carries its own `start_date`
// (YYYY-MM-DD). The instant is 09:00 local on that date so the client's
// calendar shows the intended day in any zone.

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const START_HOUR_LOCAL = 9;

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: string;
}

function localParts(at: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    weekday: get('weekday'),
  };
}

/** The UTC instant of `hour`:00 local time on the given calendar date in `timeZone`. */
function localTimeToUtc(year: number, month: number, day: number, hour: number, timeZone: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour, 0, 0);
  const seen = localParts(new Date(guess), timeZone);
  const seenAsUtc = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, 0);
  return new Date(guess - (seenAsUtc - guess));
}

function validTimeZone(tz: string | null | undefined): string {
  if (!tz) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

/**
 * ISO instant for week 1 / day 1 of an approved AI program.
 * `draftStartDate` wins when it is a real YYYY-MM-DD date.
 */
export function aiProgramStartIso(
  now: Date,
  clientTimeZone: string | null | undefined,
  draftStartDate?: unknown,
): string {
  const tz = validTimeZone(clientTimeZone);
  if (typeof draftStartDate === 'string') {
    const m = YMD.exec(draftStartDate.trim());
    if (m) {
      const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
      const check = new Date(Date.UTC(y, mo - 1, d));
      if (check.getUTCFullYear() === y && check.getUTCMonth() === mo - 1 && check.getUTCDate() === d) {
        return localTimeToUtc(y, mo, d, START_HOUR_LOCAL, tz).toISOString();
      }
    }
  }
  const today = localParts(now, tz);
  const dow = WEEKDAYS.indexOf(today.weekday); // 0 = Monday
  const daysUntilMonday = 7 - (dow < 0 ? 0 : dow); // Monday -> next week's Monday
  const target = new Date(Date.UTC(today.year, today.month - 1, today.day + daysUntilMonday));
  return localTimeToUtc(
    target.getUTCFullYear(),
    target.getUTCMonth() + 1,
    target.getUTCDate(),
    START_HOUR_LOCAL,
    tz,
  ).toISOString();
}
