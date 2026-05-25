// IsValidTimezone — class-validator constraint that accepts only IANA
// timezone strings recognized by the host's Intl implementation. Stops
// invalid tz values from being persisted (which would later crash
// Intl.DateTimeFormat in the brief service and scheduler).

import {
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

@ValidatorConstraint({ name: 'isValidTimezone', async: false })
export class IsValidTimezone implements ValidatorConstraintInterface {
  validate(tz: unknown): boolean {
    if (typeof tz !== 'string' || tz.length === 0) return false;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }

  defaultMessage(): string {
    return 'timezone must be a valid IANA timezone (e.g. America/Los_Angeles)';
  }
}

export function isValidTimezone(tz: unknown): boolean {
  if (typeof tz !== 'string' || tz.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
