// Type declarations for scripts/fly-env/fly-env-manifest.js (B-FLAGS-2).
// The module is plain CommonJS with zero dependencies so the workflow runs it
// without npm install; these types let the jest specs import it.

export type SecretState = 'github-secret' | 'present' | 'unset';
export type FlyStatus = 'Deployed' | 'Staged' | 'Partial' | 'Unknown';
export type CompareResult = 'match' | 'differs' | 'absent' | 'present';

export interface FlyEnvManifest {
  $comment: string[];
  app: string;
  /** NAME -> 'unset' or one value of the name's ENV_RULES closed set. */
  flags: Record<string, string>;
  /** NAME -> SecretState. */
  secrets: Record<string, string>;
  gates: Record<string, string>;
  excluded: Record<string, string>;
}

export interface ExtractedRule {
  values: string[] | null;
  unsetIs: 'on' | 'off' | null;
}

export interface KillSwitch {
  name: string;
  unsetIs: 'on' | 'off';
  action: 'set' | 'unset';
  value: string;
  manifest: string;
  command: string;
}

export interface FleetList {
  machines?: Array<{ id: string; state: string }>;
  malformed?: number;
  unavailable?: boolean;
  errorClass?: string;
}

export interface Fleet {
  list: FleetList;
  checks: Record<string, MachineCheck>;
}

export interface Precondition {
  id: string;
  names: string[];
  check(m: FlyEnvManifest): string | null;
}

export interface CompareInput {
  salt: string;
  expect: Record<string, string>;
  presence: string[];
}

export type MachineCheck =
  | { results: Record<string, string>; unavailable?: undefined }
  | { unavailable: true; errorClass?: string; results?: undefined };

export interface PlanRow {
  name: string;
  kind: 'flag' | 'secret';
  declared: string;
  fly: FlyStatus | 'absent';
  machine: string;
  action: 'keep' | 'set' | 'unset' | 'error';
  reason: string;
}

export interface Plan {
  rows: PlanRow[];
  errors: string[];
  setFlags: Array<[string, string]>;
  setSecrets: string[];
  unset: string[];
  pending: string[];
  unproven: string[];
  otherStaged: string[];
  otherStagedMalformed: number;
}

export interface Verification {
  errors: string[];
  warnings: string[];
  lines: string[];
  pending: string[];
  retry: string[];
  proven: { started: string[]; idle: string[] } | null;
}

export const APP: string;
export const UNSET: 'unset';
export const ENV_NAME_RE: RegExp;
export const SECRET_STATES: SecretState[];
export const COMMUNITY_SUBFLAGS: string[];
export const PRECONDITIONS: Precondition[];
export const SOURCE_SHAPES: Record<string, (v: string) => string | null>;
export const COMPARE_ENV: string;
export const COMPARE_MARKER: string;
export const COMPARE_SCHEMA: string;
export const REMOTE_PROGRAM: string;
export class ManifestError extends Error {}

export function extractEnvRules(source: string): Map<string, ExtractedRule>;
export function parseManifestText(text: string): FlyEnvManifest;
export function validateManifest(
  manifest: FlyEnvManifest,
  rules: Map<string, ExtractedRule>,
): string[];
export function loadManifest(
  manifestFile: string,
  envValidationFile: string,
): {
  manifest: FlyEnvManifest;
  rules: Map<string, ExtractedRule>;
  errors: string[];
  digest: string;
};
export function sourceChecks(
  manifest: FlyEnvManifest,
  env: Record<string, string | undefined>,
): Record<string, string>;
export function buildCompareInput(
  manifest: FlyEnvManifest,
  env: Record<string, string | undefined>,
  sources: Record<string, string>,
  salt?: Buffer,
): CompareInput;
export function compareNames(input: CompareInput): string[];
export function buildCompareCommand(input: CompareInput): string;
export function parseCompareOutput(
  text: string,
  expectedNames: string[],
): Record<string, CompareResult>;
export function parseFlyState(tsv: string): Map<string, FlyStatus>;
export function planChanges(
  manifest: FlyEnvManifest,
  flyState: Map<string, string>,
  machine: MachineCheck,
  sources: Record<string, string>,
): Plan;
export function verifyState(
  manifest: FlyEnvManifest,
  flyState: Map<string, string>,
  phase: 'staged' | 'deployed',
  fleet: Fleet | null,
  opts?: { final?: boolean },
): Verification;
export function proveFleet(
  all: Array<[string, 'present' | 'absent']>,
  notDeployed: string[],
  fleet: Fleet,
): { retry: string[]; proven: { started: string[]; idle: string[] } };
export function parseMachineList(text: string): {
  machines: Array<{ id: string; state: string }>;
  malformed: number;
};
export function offValue(values: string[]): string | null;
export function killSwitches(
  manifest: FlyEnvManifest,
  rules: Map<string, ExtractedRule>,
): KillSwitch[];
export const MACHINE_ID_RE: RegExp;
export const VERIFY_EXIT_RETRY: number;
export function renderPlan(
  plan: Plan,
  digest: string,
  machine: MachineCheck,
  kills?: KillSwitch[],
): string[];
export function main(argv: string[]): void;
