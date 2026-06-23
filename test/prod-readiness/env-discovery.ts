/**
 * prod-readiness/env-discovery.ts
 *
 * Discovers every env-var-shaped switch in the codebase from THREE sources:
 *   1. src/common/env-validation.ts (ENV_RULES) — the runtime authority.
 *   2. .env.example — the developer-onboarding authority.
 *   3. process.env.X references under src/ — what the code actually reads.
 *
 * Returns the union, plus per-source attribution so reports can show
 * "DATABASE_URL: appears in ENV_RULES + .env.example + code (3/3)" vs
 * "BOOTSTRAP_SECRET: appears in code only (1/3)".
 *
 * Three sources are deliberate: a var present in all three is wired
 * end-to-end; a var present in only one is a smell (e.g. removed from
 * code but lingering in .env.example, or used in code but absent from
 * ENV_RULES so boot never validates it).
 *
 * Code-reference discovery (F-A02 / F-B04) understands all four shapes the
 * codebase uses to read an env var, via the TypeScript AST rather than a
 * single regex:
 *   - `process.env.FOO`                         (property access)
 *   - `process.env['FOO']` / `process.env["FOO"]` (element access, string)
 *   - `process.env[CONST]` where `const CONST = 'FOO'` in the same file
 *     (element access, identifier resolved against in-file string consts)
 *   - `const { FOO, BAR } = process.env`          (destructuring)
 * Identifiers that do not resolve to a string literal (loop variables,
 * function params) are intentionally skipped — they are not statically
 * knowable env-var names.
 *
 * ENV_RULES extraction also uses the AST (F-B10): we parse the source file
 * and read the `name` property off every object literal in the ENV_RULES
 * array, so property reordering inside a rule can never break discovery.
 * We parse rather than import the module because importing
 * src/common/env-validation runs its top-level checks and can throw under a
 * partial test env.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { loadRegistry, RegistryParseError, type Registry } from './registry-loader';

export interface DiscoveryResult {
  envVars: Map<string, EnvVarOrigin>;
}

export interface EnvVarOrigin {
  inEnvRules: boolean;
  inEnvExample: boolean;
  inCode: boolean;
  /** File paths under src/ that reference this var (relative paths). */
  codeRefs: string[];
}

const ENV_VAR_NAME = /^[A-Z][A-Z0-9_]*$/;

/**
 * Discover every env-var-shaped switch across the three sources (ENV_RULES,
 * .env.example, and code references under src/).
 *
 * SCOPE — Node.js only. Code-reference discovery scans Node-style env access:
 * `process.env.*` and `process['env'].*` (property, string-element, const-keyed,
 * and destructured forms). Frontend / Vite-style `import.meta.env.*` is
 * INTENTIONALLY out of scope: this repository is a NestJS backend with no Vite
 * build, so `import.meta.env` is never a real prod env source here. A reference
 * such as `import.meta.env.VITE_FLAG` therefore contributes nothing to
 * discovery (see `extractEnvVarRefs`, which returns an empty set for it).
 */
export function discoverEnvVars(repoRoot: string = process.cwd()): DiscoveryResult {
  const result = new Map<string, EnvVarOrigin>();
  const upsert = (name: string): EnvVarOrigin => {
    let v = result.get(name);
    if (!v) {
      v = { inEnvRules: false, inEnvExample: false, inCode: false, codeRefs: [] };
      result.set(name, v);
    }
    return v;
  };

  // 1) ENV_RULES — AST extraction (property-order independent).
  const validationPath = path.join(repoRoot, 'src/common/env-validation.ts');
  if (fs.existsSync(validationPath)) {
    for (const name of extractEnvRuleNames(validationPath)) {
      upsert(name).inEnvRules = true;
    }
  }

  // 2) .env.example — every line of shape `NAME=...` is a var.
  const envExamplePath = path.join(repoRoot, '.env.example');
  if (fs.existsSync(envExamplePath)) {
    const lines = fs.readFileSync(envExamplePath, 'utf8').split('\n');
    for (const line of lines) {
      const m = /^([A-Z][A-Z0-9_]*)\s*=/.exec(line.trim());
      if (m) upsert(m[1]).inEnvExample = true;
    }
  }

  // 3) process.env references under src/ — recursive walk + AST scan.
  const srcRoot = path.join(repoRoot, 'src');
  if (fs.existsSync(srcRoot)) {
    walkTs(srcRoot, (file) => {
      const content = readUtf8OrNull(file);
      if (content === null) return; // binary / undecodable — skip (F-A13)
      const rel = path.relative(repoRoot, file);
      const names = extractEnvVarRefs(content, file);
      for (const name of names) {
        const o = upsert(name);
        o.inCode = true;
        if (!o.codeRefs.includes(rel)) o.codeRefs.push(rel);
      }
    });
  }

  return { envVars: result };
}

/**
 * Parse env-validation.ts and return every `name: '...'` string literal that
 * is a property of an object inside the ENV_RULES array initializer.
 */
export function extractEnvRuleNames(filePath: string): string[] {
  const src = fs.readFileSync(filePath, 'utf8');
  const sf = ts.createSourceFile(filePath, src, ts.ScriptTarget.Latest, true);
  const names = new Set<string>();

  const collectFromArray = (arr: ts.ArrayLiteralExpression): void => {
    for (const el of arr.elements) {
      if (!ts.isObjectLiteralExpression(el)) continue;
      for (const prop of el.properties) {
        if (
          ts.isPropertyAssignment(prop) &&
          ts.isIdentifier(prop.name) &&
          prop.name.text === 'name' &&
          ts.isStringLiteralLike(prop.initializer) &&
          ENV_VAR_NAME.test(prop.initializer.text)
        ) {
          names.add(prop.initializer.text);
        }
      }
    }
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'ENV_RULES'
    ) {
      // Unwrap `as const` / satisfies / parenthesized wrappers so the literal
      // `ENV_RULES = [...] as const` shape the codebase favours still resolves
      // to its array initializer.
      const init = node.initializer ? unwrapExpression(node.initializer) : undefined;
      if (init && ts.isArrayLiteralExpression(init)) {
        collectFromArray(init);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...names];
}

/**
 * Strip the TypeScript expression wrappers that carry no runtime meaning down to
 * the inner expression they wrap:
 *   - `(expr)`                  ParenthesizedExpression
 *   - `expr!`                   NonNullExpression
 *   - `expr as T` / `as const`  AsExpression
 *   - `<T>expr`                 TypeAssertionExpression (angle-bracket cast)
 *   - `expr satisfies T`        SatisfiesExpression
 * All five preserve the wrapped value identity, so unwrapping them lets the
 * `process.env` namespace, ENV_RULES array, and string-const initialisers be
 * recognised regardless of how many such wrappers surround them. The loop runs
 * to a fixed point, so arbitrarily nested combinations (e.g.
 * `((process.env as Record<string, string>)!)`) collapse to the core expression.
 */
function unwrapExpression(node: ts.Expression): ts.Expression {
  let cur = node;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isNonNullExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isTypeAssertionExpression(cur) ||
    ts.isSatisfiesExpression(cur)
  ) {
    cur = cur.expression;
  }
  return cur;
}

/**
 * Extract every statically-knowable env-var name referenced in one source
 * file, across all four access shapes. Identifier-keyed element accesses are
 * resolved against string `const`s declared in the same file.
 *
 * Node-scoped: only `process.env.*` and `process['env'].*` are recognised.
 * `import.meta.env.*` (Vite/frontend) is deliberately NOT recognised — this is
 * a NestJS backend with no Vite — so such a reference yields an empty set.
 */
export function extractEnvVarRefs(content: string, fileName = 'inline.ts'): Set<string> {
  const sf = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  const found = new Set<string>();
  const stringConsts = collectStringConsts(sf);

  // Recognise the `process.env` namespace in BOTH access forms the codebase
  // can use to reach it:
  //   - `process.env.X`        — property access on `process` named `env`
  //   - `process['env'].X`     — element access on `process` with the string
  //     literal key `"env"` / `'env'`
  // The outer key extraction (property `.X`, string `['X']`, const-keyed, and
  // destructuring) then applies uniformly to whichever inner form was used, so
  // `process['env'].HIDDEN` and `process['env']['HIDDEN2']` are no longer able
  // to slip past discovery.
  // `unwrap` strips TypeScript expression wrappers (`(...)`, `!`, `as T`,
  // `<T>...`, `satisfies T`) that carry no runtime meaning. Applying it before
  // every shape check means wrapped forms the codebase can legitimately write —
  // `(process.env).FOO`, `process.env!.FOO`, `(process.env as Record<...>).FOO`,
  // `(process)["env"].FOO`, `const { FOO } = (process.env)` — resolve to the
  // same core nodes as their bare equivalents instead of slipping past scan.
  const unwrap = (node: ts.Expression): ts.Expression => unwrapExpression(node);

  const isProcessEnv = (raw: ts.Expression): boolean => {
    const node = unwrap(raw);
    if (ts.isPropertyAccessExpression(node)) {
      const recv = unwrap(node.expression);
      return ts.isIdentifier(recv) && recv.text === 'process' && node.name.text === 'env';
    }
    if (ts.isElementAccessExpression(node)) {
      const recv = unwrap(node.expression);
      return (
        ts.isIdentifier(recv) &&
        recv.text === 'process' &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        node.argumentExpression.text === 'env'
      );
    }
    return false;
  };

  const add = (name: string): void => {
    if (ENV_VAR_NAME.test(name)) found.add(name);
  };

  const visit = (node: ts.Node): void => {
    // process.env.FOO
    if (ts.isPropertyAccessExpression(node) && isProcessEnv(node.expression)) {
      add(node.name.text);
    }
    // process.env['FOO'] | process.env[CONST]
    if (ts.isElementAccessExpression(node) && isProcessEnv(node.expression)) {
      const arg = node.argumentExpression;
      if (ts.isStringLiteralLike(arg)) {
        add(arg.text);
      } else if (ts.isIdentifier(arg) && stringConsts.has(arg.text)) {
        add(stringConsts.get(arg.text)!);
      }
    }
    // const { FOO, BAR } = process.env
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      isProcessEnv(node.initializer) &&
      ts.isObjectBindingPattern(node.name)
    ) {
      for (const elem of node.name.elements) {
        // Use the property name when aliased (`{ FOO: f }`), else the binding name.
        const key = elem.propertyName ?? elem.name;
        if (ts.isIdentifier(key)) {
          add(key.text);
          continue;
        }
        // Computed destructuring key — `{ ["FOO"]: x }` or `{ [K]: x }`. Resolve
        // the inner expression the same way bracket-access keys are resolved:
        // a string literal contributes its text; an identifier contributes its
        // value only when it is a resolvable (unambiguous) in-file string const.
        // Anything else (dynamic expression, unresolved/ambiguous identifier) is
        // skipped, consistent with `process.env[expr]` element-access handling.
        if (ts.isComputedPropertyName(key)) {
          const inner = unwrapExpression(key.expression);
          if (ts.isStringLiteralLike(inner)) {
            add(inner.text);
          } else if (ts.isIdentifier(inner) && stringConsts.has(inner.text)) {
            add(stringConsts.get(inner.text)!);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/**
 * Map of `const X = '<string>'` declarations (string-valued only), used to
 * resolve identifier-keyed element accesses (`process.env[X]`) to the literal
 * name the key holds.
 *
 * TWO correctness constraints, both required for a sound static key:
 *   1. CONST-ONLY (closes mutable-alias false positives): only declarations in
 *      a `const` `VariableDeclarationList` are recorded. A `let`/`var` binding
 *      can be reassigned between declaration and use, so its initial string is
 *      NOT a statically-knowable env-var name — e.g. `let K = 'FOO'; K = 'BAR';
 *      process.env[K]` must not be mis-discovered as `FOO`. We read the
 *      `NodeFlags.Const` bit off the enclosing `VariableDeclarationList`.
 *   2. LITERAL-PRESERVING UNWRAP (closes `as const` misses): the initializer is
 *      unwrapped through `as T` / `as const`, angle-bracket casts, `satisfies`,
 *      and parentheses before the string-literal check, and a
 *      `NoSubstitutionTemplateLiteral` (a backtick string with no `${}`) is
 *      accepted too. `isStringLiteralLike` already covers plain string and
 *      no-substitution-template literals; unwrapping handles the wrapped forms
 *      such as `const K = 'FOO' as const`.
 *   3. AMBIGUOUS-BINDING SKIP (closes file-wide scope shadowing, F002 + R4 F001):
 *      the map is keyed by identifier name with no lexical-scope tracking, so a
 *      name bound more than once in the file cannot be soundly resolved to a
 *      single value. The binding kinds that contribute to the count are:
 *        - `const`/`let`/`var` variable declarations (an inner block/function
 *          const that shadows an outer one, a file-scope re-declaration, or a
 *          `let`/`var` shadow of a `const`);
 *        - function / arrow-function / method parameters (R4 F001): a parameter
 *          named the same as a file-scope const shadows that const inside the
 *          body, so a dynamic `process.env[param]` read must NOT resolve to the
 *          const's value — e.g. `function f(K){return process.env[K];} const
 *          K='FOO';` must not fabricate `FOO`. Parameters parse as
 *          `ParameterDeclaration` (NOT `VariableDeclaration`), so the original
 *          walk missed them entirely; we now count them explicitly.
 *      Catch-clause variables (`try{}catch(K){process.env[K];}`) are ALREADY
 *      counted: a catch binding is itself a `ts.VariableDeclaration` node (its
 *      parent is the `CatchClause`), so the `isVariableDeclaration` branch below
 *      picks it up — a catch var that shadows a file-scope const therefore
 *      makes the name ambiguous without any special-casing (regression-tested).
 *      Per the conservative R59 "fail closed, never swallow" policy we DROP any
 *      name with more than one binding from the resolvable map entirely rather
 *      than guess outer-vs-inner. A name therefore resolves ONLY when it is
 *      bound exactly once in the file and that single binding is a
 *      string-valued `const` variable declaration.
 */
function collectStringConsts(sf: ts.SourceFile): Map<string, string> {
  // First pass: count every variable-declaration binding per identifier name,
  // across all scopes. Any name bound more than once is an ambiguous alias and
  // is excluded from resolution (F002 — ambiguous binding → skip).
  const bindingCounts = new Map<string, number>();
  const bumpBinding = (name: string): void => {
    bindingCounts.set(name, (bindingCounts.get(name) ?? 0) + 1);
  };
  const countBindings = (node: ts.Node): void => {
    // A catch-clause variable is itself a VariableDeclaration node (parent =
    // CatchClause), so this branch already counts catch bindings — no separate
    // CatchClause case is needed, and adding one would double-count.
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      bumpBinding(node.name.text);
    } else if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
      // Function, method, and arrow-function parameters all parse as
      // ParameterDeclaration (NOT VariableDeclaration), so the original walk
      // missed them. A parameter shadows any file-scope const of the same name
      // inside the body, so it must count toward ambiguity (R4 F001).
      bumpBinding(node.name.text);
    } else if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
      // BindingElement.name is the bound identifier (Identifier | BindingPattern);
      // when it is an Identifier this is the introduced name. BindingElement.propertyName
      // is the source key (renames like {x:K}) and must NOT be counted — only the bound
      // name. A destructure (`{K}`, `[K]`, `{x:K}`, `{a:{K}}`) on a VariableDeclaration,
      // Parameter, CatchClause, or for-of/for-in has node.name as an Object/Array
      // BindingPattern (NOT an Identifier), so the two arms above never fire; the bound
      // identifier lives on the inner BindingElement.name and would otherwise go
      // uncounted (R5-F001). Nested patterns (BindingElement whose .name is itself a
      // BindingPattern) are walked recursively by ts.forEachChild below.
      bumpBinding(node.name.text);
    }
    ts.forEachChild(node, countBindings);
  };
  countBindings(sf);

  // Second pass: record string-valued `const` initializers, but only for names
  // that are bound exactly once anywhere in the file.
  const map = new Map<string, string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isConstDeclaration(node) &&
      bindingCounts.get(node.name.text) === 1
    ) {
      const init = unwrapExpression(node.initializer);
      if (ts.isStringLiteralLike(init)) {
        map.set(node.name.text, init.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return map;
}

/**
 * True when a `VariableDeclaration` lives inside a `const` declaration list
 * (rejecting `let` and `var`). The const-ness is a flag on the enclosing
 * `VariableDeclarationList`, not the individual declaration, so we walk up to
 * it and test `NodeFlags.Const`.
 */
function isConstDeclaration(decl: ts.VariableDeclaration): boolean {
  const list = decl.parent;
  if (!list || !ts.isVariableDeclarationList(list)) return false;
  return (list.flags & ts.NodeFlags.Const) !== 0;
}

/**
 * Read a file as UTF-8, returning null for binary content (F-A13). We treat a
 * NUL byte within the first 1 KiB as a binary signal — text source never has
 * embedded NULs.
 */
function readUtf8OrNull(file: string): string | null {
  const buf = fs.readFileSync(file);
  const probe = buf.subarray(0, 1024);
  if (probe.indexOf(0) !== -1) return null;
  return buf.toString('utf8');
}

/**
 * Recursively walk a directory for `.ts` files. Follows directory symlinks
 * (F-A14) while tracking real (resolved) paths to avoid infinite loops on
 * cyclic links.
 */
function walkTs(
  dir: string,
  visit: (file: string) => void,
  visited: Set<string> = new Set(),
): void {
  const real = fs.realpathSync(dir);
  if (visited.has(real)) return;
  visited.add(real);
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const isDir = e.isDirectory() || (e.isSymbolicLink() && safeIsDir(p));
    if (isDir) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      walkTs(p, visit, visited);
    } else if ((e.isFile() || e.isSymbolicLink()) && p.endsWith('.ts') && !p.endsWith('.d.ts')) {
      visit(p);
    }
  }
}

function safeIsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Registry cross-reference (H4.A prod-switches.yml <-> discovered env vars).
//
// Discovery answers "what env vars exist across the three sources?"; the
// registry answers "which env vars are we deliberately tracking as prod
// switches?". Crossing the two yields the readiness signal:
//   - UNDECLARED: read by code (or onboarding) but absent from the registry -
//     a switch flips prod behaviour with no owner or prod_default. The riskiest
//     class: prod can diverge from what the registry promises.
//   - DEAD:       listed in the registry but referenced nowhere in code - a
//     stale row that lies about the surface area operators must configure.
//   - TRACKED:    present in both - wired end-to-end (the green, healthy case).
// ---------------------------------------------------------------------------

/** Classification of a single env var after crossing discovery with registry. */
export type EnvVarStatus = 'UNDECLARED' | 'DEAD' | 'TRACKED';

/**
 * Names matching this shape are test-only scaffolding, excluded from the prod
 * scan. The exclusion is PREFIX-anchored (`/^_?TEST_/`): a name is test-only
 * only when it *starts* with an optional underscore followed by `TEST_`
 * (e.g. `TEST_ONLY`, `_TEST_FLAG`). An infixed `TEST_` does NOT make a name
 * test-only, so genuine prod vars such as `MY_TEST_VAR`, `AB_TEST_BUCKET`, and
 * `FEATURE_TEST_MODE` are correctly retained in the prod readiness scan. (An
 * earlier `/(^|_)_?TEST_/` matched any `_TEST_` segment and silently hid those
 * real prod vars.)
 */
export const TEST_ONLY_ENV = /^_?TEST_/;

/** One classified env var: its name, status, registry presence, and code refs. */
export interface EnvVarFinding {
  name: string;
  status: EnvVarStatus;
  inRegistry: boolean;
  inCode: boolean;
  inEnvRules: boolean;
  inEnvExample: boolean;
  /** src/-relative files that reference this var (empty for DEAD rows). */
  codeRefs: string[];
}

/** Full readiness report: every classified var plus the registry var count. */
export interface DiscoveryReport {
  findings: EnvVarFinding[];
  /** Count of switch rows in the registry (post-validation). */
  registrySize: number;
}

/** A var is "in code" for cross-ref purposes when code OR onboarding references it. */
function isReferenced(origin: EnvVarOrigin): boolean {
  return origin.inCode || origin.inEnvExample;
}

/** True for test-only scaffolding env names excluded from the prod readiness scan. */
export function isTestOnly(name: string): boolean {
  return TEST_ONLY_ENV.test(name);
}

/**
 * Cross-reference an already-computed discovery against a loaded registry,
 * classifying every (non-test-only) name as UNDECLARED / DEAD / TRACKED.
 * Pure: no filesystem access, so it is trivially unit-testable with fixtures.
 */
export function crossReference(discovery: DiscoveryResult, registry: Registry): DiscoveryReport {
  const registryNames = new Set(registry.switches.map((r) => r.name));
  const findings: EnvVarFinding[] = [];

  for (const [name, origin] of discovery.envVars) {
    if (isTestOnly(name)) continue;
    const inRegistry = registryNames.has(name);
    const referenced = isReferenced(origin);
    if (inRegistry && referenced) {
      findings.push(toFinding(name, 'TRACKED', origin, true));
    } else if (!inRegistry && referenced) {
      findings.push(toFinding(name, 'UNDECLARED', origin, false));
    }
    // inRegistry && !referenced is impossible here: a registry-only name never
    // appears in discovery.envVars; DEAD rows are added in the next loop.
  }

  // DEAD: registry rows whose name is absent from the discovered set entirely.
  const discovered = new Set(discovery.envVars.keys());
  for (const row of registry.switches) {
    if (isTestOnly(row.name)) continue;
    if (!discovered.has(row.name)) {
      findings.push({
        name: row.name,
        status: 'DEAD',
        inRegistry: true,
        inCode: false,
        inEnvRules: false,
        inEnvExample: false,
        codeRefs: [],
      });
    }
  }

  findings.sort((a, b) => a.name.localeCompare(b.name));
  return { findings, registrySize: registry.switches.length };
}

function toFinding(
  name: string,
  status: EnvVarStatus,
  origin: EnvVarOrigin,
  inRegistry: boolean,
): EnvVarFinding {
  return {
    name,
    status,
    inRegistry,
    inCode: origin.inCode,
    inEnvRules: origin.inEnvRules,
    inEnvExample: origin.inEnvExample,
    codeRefs: [...origin.codeRefs],
  };
}

/**
 * End-to-end readiness scan: discover env vars under repoRoot, load the
 * registry at registryPath, and cross-reference. Registry load failures are
 * re-thrown wrapped with discovery context so callers see which scan failed.
 */
export async function discoverWithRegistry(
  repoRoot: string = process.cwd(),
  registryPath: string = path.join(repoRoot, 'prod-switches.yml'),
): Promise<DiscoveryReport> {
  const discovery = discoverEnvVars(repoRoot);
  let registry: Registry;
  try {
    registry = await loadRegistry(registryPath);
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new RegistryParseError(
      `env-discovery could not load registry "${registryPath}": ${reason}`,
    );
  }
  return crossReference(discovery, registry);
}

/** UNDECLARED findings - read somewhere but missing from the registry. */
export function findUndeclared(report: DiscoveryReport): EnvVarFinding[] {
  return report.findings.filter((f) => f.status === 'UNDECLARED');
}

/** DEAD findings - in the registry but referenced nowhere in code/onboarding. */
export function findDead(report: DiscoveryReport): EnvVarFinding[] {
  return report.findings.filter((f) => f.status === 'DEAD');
}

/** Per-status counts for a one-line readiness summary. */
export interface DiscoverySummary {
  undeclared: number;
  dead: number;
  tracked: number;
  total: number;
}

/** Roll a report up to per-status counts. */
export function summary(report: DiscoveryReport): DiscoverySummary {
  let undeclared = 0;
  let dead = 0;
  let tracked = 0;
  for (const f of report.findings) {
    if (f.status === 'UNDECLARED') undeclared += 1;
    else if (f.status === 'DEAD') dead += 1;
    else tracked += 1;
  }
  return { undeclared, dead, tracked, total: report.findings.length };
}
