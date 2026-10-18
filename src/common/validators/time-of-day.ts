import { Matches } from 'class-validator';

/**
 * C2-C0: a local clock time, "HH:MM" on the 24-hour clock ("07:30", "17:45").
 * The coach's planned meal and workout times use it; the database CHECKs in
 * 20270502004500 hold the same rule. Pair with @IsOptional() so null clears.
 */
export const IsTimeOfDay = () =>
  Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: '$property must be a 24-hour time, HH:MM' });
