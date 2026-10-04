// B-CI-116 / B-CI2-116: jest compiles specs TRANSPILE-ONLY (ts-jest
// isolatedModules), so build-and-test's "Type-check" step is the one type gate
// for every file jest can load. This spec resolves that gate the way GitHub
// Actions, tsc and jest resolve it, and pins what makes transpile-only safe:
//
//   1. ci.yml: build-and-test runs exactly `npx tsc --noEmit` in its one tsc
//      step, named Type-check, fail-closed (no if: or continue-on-error at
//      step or job level), before every step that runs jest, in the
//      repository root: the effective working directory is resolved from the
//      step, the job's defaults.run and the workflow's defaults.run.
//   2. TypeScript API: the project that invocation compiles is resolved with
//      ts.parseCommandLine, ts.findConfigFile and
//      ts.getParsedCommandLineOfConfigFile (extends, include/exclude and
//      command-line overrides applied). Its EFFECTIVE options keep every
//      strict-family check on (an explicit strictNullChecks:false under
//      strict:true counts as off) and noCheck off.
//   3. Coverage: every repository file that a CI jest config (jest.config.js
//      plus each --config named in ci.yml, resolved by jest-config with the
//      ts-jest preset merged) hands to ts-jest is in that program.
//   4. Memory: the first transform jest applies to each of those files is
//      ts-jest transpile-only, and workerIdleMemoryLimit, as Jest normalizes
//      it, is an absolute size at most 75% of the Test step's heap cap. Jest
//      reads numbers in (0, 1] and "N%" as a share of system RAM, which
//      scales with the runner instead of the heap cap, so those are rejected.
//
// checkGate() returns every violation. The "rejects:" cases feed it mutated
// copies of the real inputs (the GPT-6.1 Sol probes of run 37173631554 among
// them) and require a precise violation for each; the "accepts:" cases pin
// equivalent spellings that must stay green. The black-box companion
// test/ci/jest-typecheck-gate-probes.spec.ts runs this file unchanged against
// mutated inputs.
//
// Reads files only; never runs tsc, jest, git or any network call.

import * as fs from 'fs';
import { load as parseYaml } from 'js-yaml';
import { join, relative, resolve, sep } from 'path';
import * as ts from 'typescript';

const ROOT = resolve(__dirname, '..', '..');
const WORKFLOW = join(ROOT, '.github', 'workflows', 'ci.yml');
const TSCONFIG = join(ROOT, 'tsconfig.json');
const GATE_JOB = 'build-and-test';
const GATE_STEP = 'Type-check';
const GATE_RUN = 'npx tsc --noEmit';
const DEFAULT_JEST_CONFIG = 'jest.config.js';
/** Never source trees for a CI jest run (dist holds build output and emitted .d.ts files). */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage']);
/** TypeScript 5.9's strict family. The installed compiler's own list is merged in at runtime. */
const STRICT_FAMILY = [
  'alwaysStrict',
  'noImplicitAny',
  'noImplicitThis',
  'strictBindCallApply',
  'strictBuiltinIteratorReturn',
  'strictFunctionTypes',
  'strictNullChecks',
  'strictPropertyInitialization',
  'useUnknownInCatchVariables',
];
/** A recycled worker must still have room for its next file. */
const IDLE_LIMIT_MAX_SHARE_OF_HEAP = 0.75;
const MIN_SPECS = 500;

const posix = (abs: string) => relative(ROOT, abs).split(sep).join('/') || '.';
const errorText = (e: unknown) =>
  e !== null && typeof e === 'object' && 'message' in e
    ? String(e.message).split('\n')[0]
    : String(e);
const flatten = (d: ts.Diagnostic) => ts.flattenDiagnosticMessageText(d.messageText, ' ');

interface RunDefaults {
  run?: { 'working-directory'?: unknown; shell?: unknown };
}
interface Step {
  name?: string;
  uses?: string;
  run?: unknown;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
  shell?: unknown;
  'working-directory'?: unknown;
  'continue-on-error'?: unknown;
  if?: unknown;
}
interface Job {
  if?: unknown;
  'continue-on-error'?: unknown;
  defaults?: RunDefaults;
  env?: Record<string, unknown>;
  steps?: Step[];
}
interface Workflow {
  defaults?: RunDefaults;
  env?: Record<string, unknown>;
  jobs?: Record<string, Job>;
}
type RawJestConfig = Record<string, unknown>;

/** Everything the guard reads. Tests mutate a fresh copy; the real gate reads the repository. */
interface GateInputs {
  workflow: Workflow;
  /** CI jest config file (repo-relative) -> shallow copy of its module export. */
  jestConfigs: Record<string, RawJestConfig>;
  /** Virtual file text (absolute path -> content) layered over the disk for TypeScript config reads. */
  overlay: Record<string, string>;
}

interface Gate {
  cwd: string;
  args: string[];
  testHeapBytes?: number;
}

interface Program {
  configPath: string;
  options: ts.CompilerOptions;
  files: Set<string>;
}

interface EffectiveJest {
  file: string;
  raw: RawJestConfig;
  transform: Array<{ re: RegExp; path: string; options: unknown }>;
  moduleFileExtensions: string[];
  idleLimitBytes?: number;
}

interface JestConfigLib {
  readConfig(
    argv: { $0: string; _: string[] },
    config: RawJestConfig,
    skipArgvConfigOption: boolean,
    parentConfigDirname: string,
  ): Promise<{
    globalConfig: { workerIdleMemoryLimit?: number };
    projectConfig: { transform: Array<[string, string, unknown]>; moduleFileExtensions: string[] };
  }>;
}

const runOf = (s: Step | undefined) => (typeof s?.run === 'string' ? s.run : '');
const runsJest = (run: string) =>
  /(^|[\s;&|(])(npm\s+(run\s+)?test|npx\s+(--no-install\s+)?jest|jest)(\s|$)/m.test(run);
const isSet = (flag: unknown) => flag !== undefined && flag !== false;
const env = (wf: Workflow, job: Job, step: Step | undefined): Record<string, unknown> => ({
  ...wf.env,
  ...job.env,
  ...step?.env,
});

function ciJestConfigFiles(wf: Workflow): string[] {
  const files = new Set([DEFAULT_JEST_CONFIG]);
  for (const job of Object.values(wf.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      for (const m of runOf(step).matchAll(/--config[= ]+([\w./-]+)/g)) files.add(m[1]);
    }
  }
  return [...files].sort();
}

function loadInputs(): GateInputs {
  const workflow = parseYaml(fs.readFileSync(WORKFLOW, 'utf8')) as Workflow;
  const jestConfigs: Record<string, RawJestConfig> = {};
  for (const file of ciJestConfigFiles(workflow)) {
    const raw: RawJestConfig = require(join(ROOT, file));
    jestConfigs[file] = { ...raw };
  }
  return { workflow, jestConfigs, overlay: {} };
}

/** 1. The Type-check step as GitHub Actions runs it. */
function checkWorkflow(wf: Workflow, v: string[]): Gate | undefined {
  const job = wf.jobs?.[GATE_JOB];
  if (!job) {
    v.push(`ci.yml has no ${GATE_JOB} job`);
    return undefined;
  }
  if (job.if !== undefined)
    v.push(`${GATE_JOB} has a job-level if: (${String(job.if)}); the type gate must always run`);
  if (isSet(job['continue-on-error']))
    v.push(`${GATE_JOB} sets continue-on-error; a red type gate must fail the job`);
  const steps = Array.isArray(job.steps) ? job.steps : [];
  const tscSteps = steps.flatMap((s, i) => (/\btsc\b/.test(runOf(s)) ? [i] : []));
  if (tscSteps.length !== 1)
    v.push(`${GATE_JOB} must have exactly one step that runs tsc; found ${tscSteps.length}`);
  if (tscSteps.length === 0) return undefined;
  const at = tscSteps[0];
  const step = steps[at];

  if (step.name !== GATE_STEP)
    v.push(`the tsc step is named ${JSON.stringify(step.name)}, not ${GATE_STEP}`);
  if (step.if !== undefined)
    v.push(`Type-check has an if: (${String(step.if)}); the type gate must always run`);
  if (isSet(step['continue-on-error']))
    v.push('Type-check sets continue-on-error; a red type gate must fail the job');
  const shell = step.shell ?? job.defaults?.run?.shell ?? wf.defaults?.run?.shell;
  if (shell !== undefined && shell !== 'bash') {
    v.push(
      `Type-check runs under shell ${JSON.stringify(shell)}; only the runner default or bash keeps the tsc exit status`,
    );
  }
  const nodeOptions = env(wf, job, step).NODE_OPTIONS;
  if (nodeOptions !== undefined && !/^--max-old-space-size=\d+$/.test(String(nodeOptions))) {
    v.push(
      `Type-check NODE_OPTIONS ${JSON.stringify(nodeOptions)} can load code into tsc; only --max-old-space-size=<MB> is allowed`,
    );
  }
  const checkouts = steps
    .slice(0, at)
    .filter((s) => (s.uses ?? '').startsWith('actions/checkout@'));
  if (checkouts.length === 0) v.push('no actions/checkout step runs before Type-check');
  for (const c of checkouts) {
    if (c.with?.path !== undefined) {
      v.push(
        `actions/checkout sets with.path ${JSON.stringify(c.with.path)}; the repository must sit at the workspace root`,
      );
    }
  }

  const jestSteps = steps.flatMap((s, i) => (runsJest(runOf(s)) ? [i] : []));
  if (jestSteps.length === 0) v.push(`${GATE_JOB} has no step that runs jest`);
  for (const i of jestSteps) {
    if (i < at) v.push(`step ${JSON.stringify(steps[i].name ?? i)} runs jest before Type-check`);
  }
  const testStep = steps.find((s) => /^npm test\b/.test(runOf(s).trim()));
  const heap = /--max-old-space-size=(\d+)/.exec(String(env(wf, job, testStep).NODE_OPTIONS ?? ''));
  const testHeapBytes = heap ? Number(heap[1]) * 1024 * 1024 : undefined;

  // Effective working directory: step, then job defaults.run, then workflow
  // defaults.run, relative to the checkout at the workspace root.
  const levels: Array<[string, unknown]> = [
    ['step', step['working-directory']],
    [`${GATE_JOB} job defaults.run`, job.defaults?.run?.['working-directory']],
    ['workflow defaults.run', wf.defaults?.run?.['working-directory']],
  ];
  const [level, wd] = levels.find(([, value]) => value !== undefined) ?? ['runner default', '.'];
  if (typeof wd !== 'string' || wd.includes('${{')) {
    v.push(`Type-check working-directory ${JSON.stringify(wd)} (${level}) is not a static path`);
    return undefined;
  }
  const cwd = resolve(ROOT, wd);
  if (cwd !== ROOT)
    v.push(
      `Type-check runs in ${posix(cwd)} (working-directory from the ${level}), not the repository root`,
    );

  const run = runOf(step).trim();
  if (run !== GATE_RUN)
    v.push(`Type-check run is ${JSON.stringify(run)}, not exactly ${JSON.stringify(GATE_RUN)}`);
  if (!/^npx tsc( [\w./@:-]+)*$/.test(run)) {
    v.push(
      `Type-check run ${JSON.stringify(run)} is not one plain tsc command; shell operators can mask its exit status`,
    );
    return undefined;
  }
  return { cwd, args: run.split(' ').slice(2), testHeapBytes };
}

/** 2. The program that `tsc <args>` compiles from that directory. */
function resolveProgram(
  gate: Gate,
  overlay: Record<string, string>,
  v: string[],
): Program | undefined {
  const virtual = (p: string) =>
    Object.prototype.hasOwnProperty.call(overlay, resolve(p)) ? overlay[resolve(p)] : undefined;
  const host: ts.ParseConfigFileHost = {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    readDirectory: ts.sys.readDirectory,
    getCurrentDirectory: () => gate.cwd,
    fileExists: (p) => virtual(p) !== undefined || (fs.existsSync(p) && fs.statSync(p).isFile()),
    readFile: (p) => virtual(p) ?? (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : undefined),
    onUnRecoverableConfigFileDiagnostic: (d) =>
      v.push(`tsc cannot read its project: ${flatten(d)}`),
  };
  if (gate.args[0] === '-b' || gate.args[0] === '--build') {
    v.push('Type-check runs tsc in build mode');
    return undefined;
  }
  const cmd = ts.parseCommandLine(gate.args, host.readFile);
  for (const e of cmd.errors) v.push(`tsc rejects its command line: ${flatten(e)}`);
  if (cmd.fileNames.length > 0) {
    v.push(`Type-check names files (${cmd.fileNames.join(' ')}), so tsc ignores tsconfig.json`);
    return undefined;
  }
  let configPath: string | undefined;
  if (cmd.options.project !== undefined) {
    const abs = resolve(gate.cwd, cmd.options.project);
    configPath =
      fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? join(abs, 'tsconfig.json') : abs;
  } else {
    configPath = ts.findConfigFile(gate.cwd, host.fileExists);
  }
  if (!configPath || !host.fileExists(configPath)) {
    v.push(`tsc finds no project from ${posix(gate.cwd)}`);
    return undefined;
  }
  configPath = resolve(configPath);
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, cmd.options, host);
  if (!parsed) return undefined;
  for (const e of parsed.errors) v.push(`${posix(configPath)}: ${flatten(e)}`);
  return {
    configPath,
    options: parsed.options,
    files: new Set(parsed.fileNames.map((f) => posix(resolve(f)))),
  };
}

function strictFamily(): string[] {
  const decls: unknown = Reflect.get(ts, 'optionDeclarations');
  const runtime = Array.isArray(decls)
    ? decls
        .filter((d) => d && d.strictFlag === true && typeof d.name === 'string')
        .map((d) => String(d.name))
    : [];
  return [...new Set([...STRICT_FAMILY, ...runtime])].sort();
}

/** TypeScript's rule: an explicit flag wins, otherwise the strict umbrella decides. */
function effectiveStrict(options: ts.CompilerOptions, flag: string): boolean {
  const own = options[flag];
  return own === undefined ? options.strict === true : own === true;
}

function checkStrict(program: Program, v: string[]): void {
  for (const flag of strictFamily()) {
    if (!effectiveStrict(program.options, flag)) {
      v.push(
        `${posix(program.configPath)}: effective ${flag} is false; every strict-family check must stay on because jest compiles transpile-only`,
      );
    }
  }
  if (program.options.noCheck)
    v.push(`${posix(program.configPath)}: effective noCheck is on, so tsc reports no type errors`);
}

/** 3./4. What jest really does with each CI config, as jest-config resolves it. */
async function effectiveJest(inputs: GateInputs, v: string[]): Promise<EffectiveJest[]> {
  const lib: JestConfigLib = require('jest-config');
  const out: EffectiveJest[] = [];
  for (const [file, raw] of Object.entries(inputs.jestConfigs)) {
    const rootDir = raw.rootDir === undefined ? ROOT : resolve(ROOT, String(raw.rootDir));
    try {
      const { globalConfig, projectConfig } = await lib.readConfig(
        { $0: 'jest', _: [] },
        { ...raw, rootDir },
        false,
        ROOT,
      );
      out.push({
        file,
        raw,
        transform: projectConfig.transform.map(([re, path, options]) => ({
          re: new RegExp(re),
          path,
          options,
        })),
        moduleFileExtensions: projectConfig.moduleFileExtensions,
        idleLimitBytes: globalConfig.workerIdleMemoryLimit,
      });
    } catch (e) {
      v.push(`jest rejects ${file}: ${errorText(e)}`);
    }
  }
  return out;
}

let walked: string[] | undefined;
function repoFiles(): string[] {
  if (walked) return walked;
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else out.push(abs);
    }
  };
  walk(ROOT);
  walked = out;
  return out;
}

const isTsJest = (path: string) => /[\\/]ts-jest[\\/]/.test(path);
function transpileOnly(options: unknown): boolean {
  if (options === null || typeof options !== 'object' || !('tsconfig' in options)) return false;
  const tsconfig = options.tsconfig;
  return (
    tsconfig !== null &&
    typeof tsconfig === 'object' &&
    'isolatedModules' in tsconfig &&
    tsconfig.isolatedModules === true
  );
}

/** Numbers in (0, 1] and "N%" are a share of system RAM in Jest's stringToBytes. */
function proportional(raw: unknown): boolean {
  if (typeof raw === 'number') return raw > 0 && raw <= 1;
  if (typeof raw !== 'string') return false;
  const s = raw.trim();
  if (s.endsWith('%')) return true;
  if (!/^[\d.]+$/.test(s)) return false;
  const n = Number.parseFloat(s);
  return n > 0 && n <= 1;
}

function checkJest(
  configs: EffectiveJest[],
  program: Program | undefined,
  gate: Gate | undefined,
  v: string[],
): void {
  if (!program)
    v.push(
      'the Type-check program could not be resolved, so no file jest loads is proven type-checked',
    );
  for (const cfg of configs) {
    const viaTsJest: string[] = [];
    const typeChecking = new Set<string>();
    for (const f of repoFiles()) {
      // jest resolves modules only to these extensions; anything else (the
      // .tsx provider-wiring fixture, read as text) is never loaded as code.
      if (!cfg.moduleFileExtensions.includes(f.slice(f.lastIndexOf('.') + 1))) continue;
      const first = cfg.transform.find((t) => t.re.test(f));
      if (!first || !isTsJest(first.path)) continue;
      viaTsJest.push(f);
      if (!transpileOnly(first.options)) typeChecking.add(first.re.source);
    }
    if (typeChecking.size > 0) {
      v.push(
        `${cfg.file}: ts-jest type-checks files matched by ${[...typeChecking].join(', ')}; it must be transpile-only (tsconfig.isolatedModules: true)`,
      );
    }
    const specs = viaTsJest.filter((f) => f.endsWith('.spec.ts')).length;
    if (specs < MIN_SPECS)
      v.push(`${cfg.file}: only ${specs} spec files reach ts-jest; the coverage walk is vacuous`);
    if (program) {
      const missing = viaTsJest.map(posix).filter((f) => !program.files.has(f));
      const missingSpecs = missing.filter((f) => f.endsWith('.spec.ts'));
      if (missing.length > 0) {
        const sample = [...missingSpecs, ...missing.filter((f) => !f.endsWith('.spec.ts'))].slice(
          0,
          8,
        );
        v.push(
          `${cfg.file}: ${missing.length} file(s) jest compiles with ts-jest, ${missingSpecs.length} of them specs, are outside the Type-check program ${posix(program.configPath)}: ${sample.join(', ')}`,
        );
      }
    }
  }

  const dflt = configs.find((c) => c.file === DEFAULT_JEST_CONFIG);
  if (!dflt) return;
  const raw = dflt.raw.workerIdleMemoryLimit;
  const bytes = dflt.idleLimitBytes;
  const cap = gate?.testHeapBytes;
  if (raw === undefined) {
    v.push(`${DEFAULT_JEST_CONFIG} sets no workerIdleMemoryLimit`);
  } else if (proportional(raw)) {
    v.push(
      `workerIdleMemoryLimit ${JSON.stringify(raw)} is a share of system RAM in Jest, so it scales with the runner instead of the worker heap cap; use an absolute size such as '2GB'`,
    );
  } else if (bytes === undefined || !(bytes > 0)) {
    v.push(`workerIdleMemoryLimit ${JSON.stringify(raw)} disables worker recycling`);
  } else if (cap === undefined) {
    v.push(
      'the Test step sets no --max-old-space-size in NODE_OPTIONS, so the worker heap cap is unknown',
    );
  } else if (bytes > cap * IDLE_LIMIT_MAX_SHARE_OF_HEAP) {
    v.push(
      `workerIdleMemoryLimit ${JSON.stringify(raw)} (${bytes} bytes) is above ${IDLE_LIMIT_MAX_SHARE_OF_HEAP * 100}% of the Test step heap cap (${cap} bytes)`,
    );
  }
}

async function checkGate(inputs: GateInputs): Promise<string[]> {
  const v: string[] = [];
  const gate = checkWorkflow(inputs.workflow, v);
  const program = gate ? resolveProgram(gate, inputs.overlay, v) : undefined;
  if (program) checkStrict(program, v);
  checkJest(await effectiveJest(inputs, v), program, gate, v);
  return v;
}

// ---------------------------------------------------------------------------
// Mutation helpers for the self-tests (each works on a fresh loadInputs()).
// ---------------------------------------------------------------------------

function gateJob(i: GateInputs): Job {
  const job = i.workflow.jobs?.[GATE_JOB];
  if (!job) throw new Error(`ci.yml has no ${GATE_JOB} job`);
  return job;
}
function namedStep(i: GateInputs, name: string): Step {
  const step = (gateJob(i).steps ?? []).find((s) => s.name === name);
  if (!step) throw new Error(`${GATE_JOB} has no ${name} step`);
  return step;
}
const typeCheck = (i: GateInputs) => namedStep(i, GATE_STEP);
function editTsconfig(
  i: GateInputs,
  edit: (compilerOptions: Record<string, unknown>, cfg: Record<string, unknown>) => void,
): void {
  const text = fs.readFileSync(TSCONFIG, 'utf8');
  const parsed = ts.parseConfigFileTextToJson(TSCONFIG, text);
  if (parsed.error) throw new Error(flatten(parsed.error));
  const cfg: Record<string, unknown> = parsed.config;
  const compilerOptions = record(cfg.compilerOptions);
  edit(compilerOptions, cfg);
  i.overlay[TSCONFIG] = JSON.stringify({ ...cfg, compilerOptions });
}
function record(x: unknown): Record<string, unknown> {
  return x !== null && typeof x === 'object' ? { ...x } : {};
}
const editJest = (i: GateInputs, edit: (cfg: RawJestConfig) => void) =>
  edit(i.jestConfigs[DEFAULT_JEST_CONFIG]);

interface Case {
  name: string;
  mutate: (i: GateInputs) => void;
  /** Every pattern must match some violation. */
  expect: RegExp[];
}

const SECRETS = 'scripts/secrets';
const NARROW = /scripts\/secrets\/tsconfig\.json: effective strictNullChecks is false/;
const NARROW_MISSING =
  /[1-9]\d* of them specs, are outside the Type-check program scripts\/secrets\/tsconfig\.json: /;

const REJECTS: Case[] = [
  // GPT-6.1 Sol probes (run 37173631554).
  {
    name: 'Sol probe 1: Type-check step working-directory scripts/secrets (narrow strict:false project)',
    mutate: (i) => void (typeCheck(i)['working-directory'] = SECRETS),
    expect: [
      /Type-check runs in scripts\/secrets \(working-directory from the step\)/,
      NARROW,
      NARROW_MISSING,
    ],
  },
  {
    name: 'Sol probe 2: strictNullChecks:false while strict:true remains',
    mutate: (i) => editTsconfig(i, (o) => void (o.strictNullChecks = false)),
    expect: [/^tsconfig\.json: effective strictNullChecks is false/],
  },
  // Every other way to move or narrow the project tsc compiles.
  {
    name: 'build-and-test job defaults.run.working-directory scripts/secrets',
    mutate: (i) => void (gateJob(i).defaults = { run: { 'working-directory': SECRETS } }),
    expect: [
      /runs in scripts\/secrets \(working-directory from the build-and-test job defaults\.run\)/,
      NARROW,
      NARROW_MISSING,
    ],
  },
  {
    name: 'workflow defaults.run.working-directory scripts/secrets',
    mutate: (i) => void (i.workflow.defaults = { run: { 'working-directory': SECRETS } }),
    expect: [
      /runs in scripts\/secrets \(working-directory from the workflow defaults\.run\)/,
      NARROW,
      NARROW_MISSING,
    ],
  },
  {
    name: 'working-directory from an expression',
    mutate: (i) =>
      void (typeCheck(i)['working-directory'] = '${{ github.workspace }}/scripts/secrets'),
    expect: [/is not a static path/, /Type-check program could not be resolved/],
  },
  {
    name: 'tsc -p scripts/secrets',
    mutate: (i) => void (typeCheck(i).run = `${GATE_RUN} -p ${SECRETS}`),
    expect: [/not exactly "npx tsc --noEmit"/, NARROW, NARROW_MISSING],
  },
  {
    name: 'tsc -p tsconfig.build.json (excludes every spec)',
    mutate: (i) => void (typeCheck(i).run = `${GATE_RUN} -p tsconfig.build.json`),
    expect: [
      /[1-9]\d* of them specs, are outside the Type-check program tsconfig\.build\.json: src\/.*\.spec\.ts/,
    ],
  },
  {
    name: 'tsc --project with a directory argument (scripts/secrets)',
    mutate: (i) => void (typeCheck(i).run = `${GATE_RUN} --project ${SECRETS}`),
    expect: [NARROW, NARROW_MISSING],
  },
  {
    name: 'tsc with file arguments (tsconfig.json ignored)',
    mutate: (i) => void (typeCheck(i).run = `${GATE_RUN} src/main.ts`),
    expect: [/so tsc ignores tsconfig\.json/, /could not be resolved/],
  },
  {
    name: 'tsc --strict false on the command line',
    mutate: (i) => void (typeCheck(i).run = `${GATE_RUN} --strict false`),
    expect: [
      /^tsconfig\.json: effective strictBindCallApply is false/,
      /^tsconfig\.json: effective strictFunctionTypes is false/,
    ],
  },
  {
    name: 'tsc --noCheck on the command line',
    mutate: (i) => void (typeCheck(i).run = `${GATE_RUN} --noCheck`),
    expect: [/effective noCheck is on/],
  },
  {
    name: 'tsc in build mode',
    mutate: (i) => void (typeCheck(i).run = 'npx tsc -b'),
    expect: [/build mode/],
  },
  {
    name: 'exit status masked with || true',
    mutate: (i) => void (typeCheck(i).run = `${GATE_RUN} || true`),
    expect: [/not one plain tsc command/, /could not be resolved/],
  },
  {
    name: 'cd into another directory inside run',
    mutate: (i) => void (typeCheck(i).run = `cd ${SECRETS} && ${GATE_RUN}`),
    expect: [/not one plain tsc command/],
  },
  // Fail-closed step and job semantics.
  {
    name: 'Type-check step if: false',
    mutate: (i) => void (typeCheck(i).if = 'false'),
    expect: [/Type-check has an if:/],
  },
  {
    name: 'Type-check step continue-on-error: true',
    mutate: (i) => void (typeCheck(i)['continue-on-error'] = true),
    expect: [/Type-check sets continue-on-error/],
  },
  {
    name: 'build-and-test job continue-on-error: true',
    mutate: (i) => void (gateJob(i)['continue-on-error'] = true),
    expect: [/build-and-test sets continue-on-error/],
  },
  {
    name: 'build-and-test job if:',
    mutate: (i) => void (gateJob(i).if = "github.event_name == 'push'"),
    expect: [/job-level if:/],
  },
  {
    name: 'Type-check moved after Test',
    mutate: (i) => {
      const steps = gateJob(i).steps ?? [];
      const step = typeCheck(i);
      steps.splice(steps.indexOf(step), 1);
      steps.push(step);
    },
    expect: [/step "Test" runs jest before Type-check/],
  },
  {
    name: 'Type-check removed',
    mutate: (i) => {
      const steps = gateJob(i).steps ?? [];
      steps.splice(steps.indexOf(typeCheck(i)), 1);
    },
    expect: [/exactly one step that runs tsc; found 0/, /could not be resolved/],
  },
  {
    name: 'a second tsc step',
    mutate: (i) =>
      void (gateJob(i).steps ?? []).push({
        name: 'Extra',
        run: 'npx tsc -p tsconfig.build.json --noEmit',
      }),
    expect: [/exactly one step that runs tsc; found 2/],
  },
  {
    name: 'tsc step renamed',
    mutate: (i) => void (typeCheck(i).name = 'Types'),
    expect: [/the tsc step is named "Types"/],
  },
  {
    name: 'checkout into a sub-directory',
    mutate: (i) => {
      const checkout = (gateJob(i).steps ?? []).find((s) =>
        (s.uses ?? '').startsWith('actions/checkout@'),
      );
      if (!checkout) throw new Error('no checkout step');
      checkout.with = { ...checkout.with, path: 'src' };
    },
    expect: [/actions\/checkout sets with\.path "src"/],
  },
  {
    name: 'Type-check under a non-bash shell',
    mutate: (i) => void (typeCheck(i).shell = 'python {0}'),
    expect: [/runs under shell "python \{0\}"/],
  },
  {
    name: 'NODE_OPTIONS that preloads code into tsc',
    mutate: (i) => void (typeCheck(i).env = { NODE_OPTIONS: '--require ./scripts/patch-tsc.js' }),
    expect: [/NODE_OPTIONS "--require \.\/scripts\/patch-tsc\.js" can load code into tsc/],
  },
  // Effective TypeScript options and program coverage.
  ...STRICT_FAMILY.map((flag): Case => ({
    name: `${flag}:false while strict:true remains`,
    mutate: (i) => editTsconfig(i, (o) => void (o[flag] = false)),
    expect: [new RegExp(`^tsconfig\\.json: effective ${flag} is false`)],
  })),
  {
    name: 'strict:false (only strictNullChecks and noImplicitAny stay explicit)',
    mutate: (i) => editTsconfig(i, (o) => void (o.strict = false)),
    expect: [
      /effective strictFunctionTypes is false/,
      /effective useUnknownInCatchVariables is false/,
    ],
  },
  {
    name: 'noCheck:true in tsconfig.json',
    mutate: (i) => editTsconfig(i, (o) => void (o.noCheck = true)),
    expect: [/effective noCheck is on/],
  },
  {
    name: 'tsconfig.json excludes test/ci/** (control kept from round 0)',
    mutate: (i) =>
      editTsconfig(
        i,
        (_o, cfg) =>
          void (cfg.exclude = [...(Array.isArray(cfg.exclude) ? cfg.exclude : []), 'test/ci/**']),
      ),
    expect: [
      /[1-9]\d* of them specs, are outside the Type-check program tsconfig\.json: test\/ci\//,
    ],
  },
  {
    name: 'tsconfig.json include narrowed to src',
    mutate: (i) => editTsconfig(i, (_o, cfg) => void (cfg.include = ['src'])),
    expect: [/[1-9]\d* of them specs, are outside the Type-check program tsconfig\.json: test\//],
  },
  // Jest transform and worker recycling (C-694-2).
  {
    name: 'ts-jest transform without isolatedModules',
    mutate: (i) =>
      editJest(
        i,
        (c) =>
          void (c.transform = {
            ...record(c.transform),
            '^.+\\.ts$': ['ts-jest', { tsconfig: { strict: false } }],
          }),
      ),
    expect: [/jest\.config\.js: ts-jest type-checks files matched by \^\.\+\\\.ts\$/],
  },
  {
    name: 'a type-checking ts-jest transform ahead of the transpile-only one',
    mutate: (i) =>
      editJest(
        i,
        (c) => void (c.transform = { '^.+\\.tsx?$': ['ts-jest', {}], ...record(c.transform) }),
      ),
    expect: [/ts-jest type-checks files matched by \^\.\+\\\.tsx\?\$/],
  },
  {
    name: 'C-694-2: numeric workerIdleMemoryLimit 0.9 (90% of system RAM)',
    mutate: (i) => editJest(i, (c) => void (c.workerIdleMemoryLimit = 0.9)),
    expect: [/workerIdleMemoryLimit 0\.9 is a share of system RAM/],
  },
  {
    name: 'C-694-2: string workerIdleMemoryLimit "0.5"',
    mutate: (i) => editJest(i, (c) => void (c.workerIdleMemoryLimit = '0.5')),
    expect: [/workerIdleMemoryLimit "0\.5" is a share of system RAM/],
  },
  {
    name: 'C-694-2: percentage workerIdleMemoryLimit "50%"',
    mutate: (i) => editJest(i, (c) => void (c.workerIdleMemoryLimit = '50%')),
    expect: [/workerIdleMemoryLimit "50%" is a share of system RAM/],
  },
  {
    name: 'workerIdleMemoryLimit above 75% of the Test heap cap',
    mutate: (i) => editJest(i, (c) => void (c.workerIdleMemoryLimit = '3.5GB')),
    expect: [
      /workerIdleMemoryLimit "3\.5GB" \(3500000000 bytes\) is above 75% of the Test step heap cap \(4294967296 bytes\)/,
    ],
  },
  {
    name: 'workerIdleMemoryLimit 0 (recycling off)',
    mutate: (i) => editJest(i, (c) => void (c.workerIdleMemoryLimit = 0)),
    expect: [/workerIdleMemoryLimit 0 disables worker recycling/],
  },
  {
    name: 'workerIdleMemoryLimit removed',
    mutate: (i) => editJest(i, (c) => void delete c.workerIdleMemoryLimit),
    expect: [/sets no workerIdleMemoryLimit/],
  },
  {
    name: 'workerIdleMemoryLimit Jest cannot parse ("2 GB")',
    mutate: (i) => editJest(i, (c) => void (c.workerIdleMemoryLimit = '2 GB')),
    expect: [/jest rejects jest\.config\.js: Unexpected input/],
  },
  {
    name: 'Test step without a heap cap',
    mutate: (i) =>
      void (namedStep(i, 'Test').env = { THROTTLER_LIVE_REDIS_URL: 'redis://localhost:6379/0' }),
    expect: [/Test step sets no --max-old-space-size/],
  },
];

/** Equivalent spellings that resolve to the same gate; they must stay green. */
const ACCEPTS: Array<Omit<Case, 'expect'>> = [
  {
    name: 'Type-check working-directory "."',
    mutate: (i) => void (typeCheck(i)['working-directory'] = '.'),
  },
  {
    name: 'job defaults.run.working-directory "./"',
    mutate: (i) => void (gateJob(i).defaults = { run: { 'working-directory': './' } }),
  },
  {
    name: 'strict:false with every strict-family flag explicitly true',
    mutate: (i) =>
      editTsconfig(i, (o) => {
        o.strict = false;
        for (const flag of strictFamily()) o[flag] = true;
      }),
  },
  {
    name: 'absolute workerIdleMemoryLimit "1.5GiB"',
    mutate: (i) => editJest(i, (c) => void (c.workerIdleMemoryLimit = '1.5GiB')),
  },
];

describe('jest transpile-only is safe: tsc --noEmit is the type gate (B-CI-116, B-CI2-116)', () => {
  it('build-and-test type-checks every file jest loads, from the repo root, with effective strict options', async () => {
    expect(await checkGate(loadInputs())).toEqual([]);
  });

  it('the installed TypeScript still publishes the strict family this guard pins', () => {
    const decls: unknown = Reflect.get(ts, 'optionDeclarations');
    expect(Array.isArray(decls)).toBe(true);
    const runtime = new Set(
      (Array.isArray(decls) ? decls : [])
        .filter((d) => d && d.strictFlag === true)
        .map((d) => String(d.name)),
    );
    expect(STRICT_FAMILY.filter((flag) => !runtime.has(flag))).toEqual([]);
  });

  it("effectiveStrict() matches TypeScript's own getStrictOptionValue", () => {
    const own: unknown = Reflect.get(ts, 'getStrictOptionValue');
    if (typeof own !== 'function')
      throw new Error('typescript no longer exposes getStrictOptionValue');
    for (const strict of [true, false, undefined]) {
      for (const value of [true, false, undefined]) {
        for (const flag of strictFamily()) {
          const options: ts.CompilerOptions = { strict, [flag]: value };
          expect([flag, strict, value, effectiveStrict(options, flag)]).toEqual([
            flag,
            strict,
            value,
            own(options, flag) === true,
          ]);
        }
      }
    }
  });

  for (const c of REJECTS) {
    it(`rejects: ${c.name}`, async () => {
      const inputs = loadInputs();
      c.mutate(inputs);
      const violations = await checkGate(inputs);
      expect(violations).toEqual(
        expect.arrayContaining(c.expect.map((pattern) => expect.stringMatching(pattern))),
      );
    });
  }

  for (const c of ACCEPTS) {
    it(`accepts: ${c.name}`, async () => {
      const inputs = loadInputs();
      c.mutate(inputs);
      expect(await checkGate(inputs)).toEqual([]);
    });
  }
});
