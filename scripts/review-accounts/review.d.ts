export interface ReviewConfig {
  baseUrl: string;
  endDate: string;
  local: boolean;
  coachEmail?: string;
  coachPassword?: string;
  clientEmail?: string;
  clientPassword?: string;
}
export type Role = 'coach' | 'client';
export type RequestPlan = (
  role: Role,
  method: string,
  path: string,
  body?: Record<string, unknown>,
  token?: string,
  idempotencyKey?: string,
) => Promise<unknown>;
export interface ReviewReport {
  created: Record<string, number>;
  skipped: Record<string, number>;
  packageId: string;
  programId: string;
  bookingId: string;
  activePlan: boolean;
  communityMembership: boolean;
  bookingStatus: string;
  nextStep: string;
}
export function readConfig(env: Record<string, string | undefined>, apply?: boolean): ReviewConfig;
export function describePlan(config: ReviewConfig): Record<string, unknown>;
export function httpTransport(config: ReviewConfig, fetchImpl?: typeof fetch): RequestPlan;
export function seed(config: ReviewConfig, request?: RequestPlan): Promise<ReviewReport>;
export function day(anchor: string, offset: number): string;
export function key(text: string): string;
