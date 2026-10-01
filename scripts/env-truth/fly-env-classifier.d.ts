// Type declarations for scripts/env-truth/fly-env-classifier.js (S-ENVTRUTH).
// The classifier is plain CommonJS with zero dependencies so it can run inline
// inside the Fly machine; these types let the jest specs import it.

export interface EnvTruthRow {
  name: string;
  registered: boolean;
  present: boolean;
  empty: boolean;
  placeholder: string | null;
  duplicateGroup: string | null;
  lengthBucket: string;
  suspiciousName: boolean;
}

export interface EnvTruthSummary {
  registered: number;
  present: number;
  registeredMissing: number;
  empty: number;
  placeholder: number;
  duplicateGroups: number;
  duplicateKeys: number;
  unregisteredPresent: number;
  suspiciousNames: number;
  shapeChecksFailing: number;
}

export interface ShapeCheckResult {
  name: string;
  check: string;
  describe: string;
  result: 'pass' | 'fail' | 'missing';
}

export interface EnvTruthReport {
  schema: 'env-truth/v1';
  generatedAt: string;
  summary: EnvTruthSummary;
  shapeChecks: ShapeCheckResult[];
  rows: EnvTruthRow[];
}

export interface ClassifyOptions {
  salt?: Buffer;
  now?: string;
}

export const ENV_NAME_RE: RegExp;
export const REPORT_MARKER: string;
export const PLACEHOLDER_PATTERNS: ReadonlyArray<[string, (value: string) => boolean]>;
export const IOS_BUNDLE_ID: string;
export const SHAPE_CHECKS: ReadonlyArray<{
  name: string;
  check: string;
  describe: string;
  test: (value: string) => boolean;
}>;
export function shapeChecks(env: Record<string, string | undefined>): ShapeCheckResult[];
export function placeholderPattern(value: string): string | null;
export function lengthBucket(len: number): string;
export function suspiciousName(name: string): boolean;
export function duplicateGroups(
  env: Record<string, string | undefined>,
  names: readonly string[],
  salt?: Buffer,
): Map<string, string>;
export function classifyEnv(
  env: Record<string, string | undefined>,
  registered: readonly string[],
  opts?: ClassifyOptions,
): EnvTruthReport;
export function extractRegisteredNames(source: string): string[];
export function renderMarkdown(report: EnvTruthReport, app?: string): string;
export const NAMES_ENV: string;
export function buildRemoteProgram(moduleSource: string): string;
export function encodeNames(names: readonly string[]): string;
export function namesFromEnv(env: Record<string, string | undefined>): string[];
export function buildRemoteCommand(moduleSource: string, names: readonly string[]): string;
export function runRemote(names: readonly string[]): void;
export function parseRemoteOutput(text: string): EnvTruthReport;
