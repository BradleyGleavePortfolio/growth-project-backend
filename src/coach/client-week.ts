import { civilDayNumber, civilFromDayNumber, zonedParts, zonedWallTimeToUtc } from '../broadcasts/tz';

const isoDay = (n: number) => new Date(n * 86_400_000).toISOString().slice(0, 10);

/**
 * K1WEEK: the Monday-to-Sunday week that holds `now` in the IANA zone `tz`:
 * its first and current local days (YYYY-MM-DD), the instants it runs between
 * ([from, to), local midnight to local midnight, so a DST week is 167 or 169
 * hours), and the local day of any instant.
 */
export function clientWeek(now: Date, tz: string) {
  const dayNumber = (at: Date) => {
    const p = zonedParts(at, tz);
    return civilDayNumber(p.year, p.month, p.day);
  };
  const midnight = (n: number) => {
    const c = civilFromDayNumber(n);
    return zonedWallTimeToUtc(c.year, c.month, c.day, 0, 0, tz);
  };
  const today = dayNumber(now);
  const monday = today - ((civilFromDayNumber(today).weekday + 6) % 7);
  return {
    start: isoDay(monday),
    today: isoDay(today),
    from: midnight(monday),
    to: midnight(monday + 7),
    dayOf: (at: Date) => isoDay(dayNumber(at)),
  };
}
