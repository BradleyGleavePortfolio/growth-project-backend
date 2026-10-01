/**
 * Typed seams for scheduling test doubles. The SchedulingService takes a
 * concrete AuditService and BookingEmitter; specs only need their write /
 * emit methods. Keeping the one narrowing per type here (instead of in
 * every spec) keeps the R75 cast count flat as scheduling specs grow.
 */
import type { AuditService } from '../../src/audit/audit.service';
import type { SchedulingService } from '../../src/scheduling/scheduling.service';

type EmitterArg = ConstructorParameters<typeof SchedulingService>[3];

export function auditDouble(fake: { write: (...args: never[]) => unknown }): AuditService {
  return fake as unknown as AuditService;
}

export function bookingEmitterDouble(fake: Partial<Record<keyof EmitterArg, unknown>>): EmitterArg {
  return fake as unknown as EmitterArg;
}
