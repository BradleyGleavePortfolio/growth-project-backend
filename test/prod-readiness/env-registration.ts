/**
 * prod-readiness/env-registration.ts (S-ENVTRUTH)
 *
 * Code invariant: every env var NAME that runtime code under src/ reads must be
 * registered in src/common/env-validation.ts (ENV_RULES). A name that code
 * reads but the registry does not know about is invisible to the boot
 * validator, to the H4 env-discovery board, to the operator keys list, and to
 * the in-machine env-truth classifier (fly-env-truth.yml). That is exactly how
 * 91 names ended up "read by code, never set anywhere" (operator env-truth
 * audit 2026-10-01).
 *
 * Unlike env-discovery.ts (which only sees direct `process.env` access), this
 * scanner also follows the indirect shapes the codebase actually uses:
 *
 *   1. Direct access                 process.env.X / process.env['X'] /
 *                                    process.env[CONST] / const { X } = process.env
 *                                    (delegated to env-discovery's extractEnvVarRefs)
 *   2. ProcessEnv aliases            fn(env: NodeJS.ProcessEnv = process.env) { env.X }
 *                                    const env = process.env; env['X']
 *   3. Nest ConfigService            this.config.get('X') / config.getOrThrow<T>('X')
 *                                    (receiver text must contain "config")
 *   4. Env-reading helpers           function readIntEnv(name) { process.env[name] }
 *                                    readIntEnv('X', ...), this.requireEnv(ENV.clientId)
 *                                    Helpers are detected structurally (a parameter used
 *                                    as a process.env key). Calls resolve in the same file,
 *                                    or in another file that imports the helper by name.
 *   5. Template-built names          process.env[`${P}_CLIENT_ID`] / helper(`${P}_X`)
 *                                    expanded over TEMPLATE_PREFIXES (wearables providers).
 *
 * Arguments are resolved through string literals, no-substitution templates,
 * single-binding string consts, const object-literal members (ENV.clientId),
 * and both arms of a conditional. Anything else is a DYNAMIC site: it is
 * reported with file + expression text and must be listed in
 * DYNAMIC_ENV_SITES with the names it can read. A new dynamic read therefore
 * fails the invariant until a human records what it reads (fail closed).
 *
 * Scope: src/ runtime TypeScript only. *.spec.ts, __tests__/ and *.d.ts are
 * skipped (fixtures assign fake values to env names; they are not runtime
 * reads). README/markdown is not scanned.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { extractEnvVarRefs, extractEnvRuleNames } from './env-discovery';

const ENV_VAR_NAME = /^[A-Z][A-Z0-9_]*$/;

/**
 * Prefixes substituted into template-built env names (`${PROVIDER}_CLIENT_ID`).
 * The eight cloud-wearable providers the connectors under src/wearables/ serve.
 */
export const TEMPLATE_PREFIXES: readonly string[] = [
  'FITBIT',
  'GARMIN',
  'OURA',
  'POLAR',
  'STRAVA',
  'WAHOO',
  'WHOOP',
  'WITHINGS',
];

/**
 * Dynamic env reads the scanner cannot resolve statically, with the names each
 * one can read. Keyed by `<src-relative path>::<expression text>`. Every name
 * listed here must itself be registered in ENV_RULES (the invariant checks it).
 * Adding a new dynamic env read to src/ fails the invariant until it is listed.
 */
export const DYNAMIC_ENV_SITES: Readonly<Record<string, readonly string[]>> = {
  // isFlagDark(routes) reads process.env[route.envVar] for rows of
  // FEATURE_GATED_ROUTES, which is declared in feature-flag-not-found.middleware.ts
  // (the middleware's own read resolves statically). The spec asserts this
  // list equals that table's envVar set so the two cannot drift.
  'src/common/feature-flag/pilot-coach-allowlist.ts::route.envVar': [
    'FEATURE_SCOUT_INGEST',
    'FEATURE_SCOUT_RECONSTRUCT',
    'FEATURE_EXTENSION_PAIRING',
  ],
};

/** One unresolved dynamic env read. */
export interface DynamicEnvSite {
  file: string;
  line: number;
  expr: string;
}

/** Per-file scan output. */
export interface FileEnvScan {
  names: Set<string>;
  dynamic: DynamicEnvSite[];
}

/** Repo-wide scan output. */
export interface EnvReadScan {
  /** name -> src-relative files reading it */
  reads: Map<string, string[]>;
  dynamic: DynamicEnvSite[];
}

interface HelperSig {
  name: string;
  paramIndex: number;
}

function unwrap(node: ts.Expression): ts.Expression {
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

function isProcessEnvExpr(raw: ts.Expression): boolean {
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
}

/** Collect single-binding string consts and const object-literal string members. */
function collectConsts(sf: ts.SourceFile): {
  strings: Map<string, string>;
  objects: Map<string, Map<string, string>>;
  arrays: Map<string, string[]>;
  forOf: Map<string, string>;
  propertyTable: Map<string, Set<string>>;
} {
  const counts = new Map<string, number>();
  const bump = (n: string): void => {
    counts.set(n, (counts.get(n) ?? 0) + 1);
  };
  const count = (node: ts.Node): void => {
    if (
      (ts.isVariableDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isBindingElement(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name)
    ) {
      bump(node.name.text);
    }
    ts.forEachChild(node, count);
  };
  count(sf);

  const strings = new Map<string, string>();
  const objects = new Map<string, Map<string, string>>();
  const arrays = new Map<string, string[]>();
  const forOf = new Map<string, string>();
  // Every `prop: 'ENV_NAME'` assignment in the file, keyed by prop name. Used to
  // resolve property-keyed reads such as `process.env[route.envVar]` against a
  // route table declared in the same file.
  const propertyTable = new Map<string, Set<string>>();
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)) {
      const val = unwrap(node.initializer);
      if (ts.isStringLiteralLike(val) && ENV_VAR_NAME.test(val.text)) {
        const set = propertyTable.get(node.name.text) ?? new Set<string>();
        set.add(val.text);
        propertyTable.set(node.name.text, set);
      }
    }
    if (
      ts.isForOfStatement(node) &&
      ts.isVariableDeclarationList(node.initializer) &&
      node.initializer.declarations.length === 1
    ) {
      const d = node.initializer.declarations[0];
      const iter = unwrap(node.expression);
      if (ts.isIdentifier(d.name) && ts.isIdentifier(iter) && counts.get(d.name.text) === 1) {
        forOf.set(d.name.text, iter.text);
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      counts.get(node.name.text) === 1 &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      const init = unwrap(node.initializer);
      if (ts.isStringLiteralLike(init)) strings.set(node.name.text, init.text);
      if (ts.isObjectLiteralExpression(init)) {
        const members = new Map<string, string>();
        for (const p of init.properties) {
          if (!ts.isPropertyAssignment(p)) continue;
          const key =
            ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name) ? p.name.text : undefined;
          const val = unwrap(p.initializer);
          if (key && ts.isStringLiteralLike(val)) members.set(key, val.text);
        }
        if (members.size > 0) objects.set(node.name.text, members);
      }
      if (ts.isArrayLiteralExpression(init)) {
        const items = init.elements.map((el) => unwrap(el as ts.Expression));
        if (items.length > 0 && items.every((el) => ts.isStringLiteralLike(el))) {
          arrays.set(
            node.name.text,
            items.map((el) => (ts.isStringLiteralLike(el) ? el.text : '')),
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { strings, objects, arrays, forOf, propertyTable };
}

type Resolution = { kind: 'names'; names: string[] } | { kind: 'dynamic' };

function makeResolver(sf: ts.SourceFile): (e: ts.Expression) => Resolution {
  const { strings, objects, arrays, forOf, propertyTable } = collectConsts(sf);
  const resolve = (raw: ts.Expression): Resolution => {
    const e = unwrap(raw);
    if (ts.isStringLiteralLike(e)) return { kind: 'names', names: [e.text] };
    if (ts.isIdentifier(e) && strings.has(e.text)) {
      return { kind: 'names', names: [strings.get(e.text)!] };
    }
    // `for (const key of CONST_ARRAY) process.env[key]`
    if (ts.isIdentifier(e) && forOf.has(e.text) && arrays.has(forOf.get(e.text)!)) {
      return { kind: 'names', names: [...arrays.get(forOf.get(e.text)!)!] };
    }
    if (ts.isPropertyAccessExpression(e)) {
      const recv = unwrap(e.expression);
      if (ts.isIdentifier(recv) && objects.get(recv.text)?.has(e.name.text)) {
        return { kind: 'names', names: [objects.get(recv.text)!.get(e.name.text)!] };
      }
      // `process.env[row.envVar]` against a same-file `{ envVar: 'X' }` table.
      const table = propertyTable.get(e.name.text);
      if (ts.isIdentifier(recv) && !objects.has(recv.text) && table && table.size > 0) {
        return { kind: 'names', names: [...table] };
      }
    }
    if (ts.isConditionalExpression(e)) {
      const a = resolve(e.whenTrue);
      const b = resolve(e.whenFalse);
      if (a.kind === 'names' && b.kind === 'names') {
        return { kind: 'names', names: [...a.names, ...b.names] };
      }
      return { kind: 'dynamic' };
    }
    if (ts.isTemplateExpression(e)) {
      // `${X}_SUFFIX` with a single leading substitution → expand prefixes.
      if (e.head.text === '' && e.templateSpans.length === 1) {
        const suffix = e.templateSpans[0].literal.text;
        if (/^_[A-Z0-9_]+$/.test(suffix)) {
          return { kind: 'names', names: TEMPLATE_PREFIXES.map((p) => `${p}${suffix}`) };
        }
      }
      return { kind: 'dynamic' };
    }
    return { kind: 'dynamic' };
  };
  return resolve;
}

/** Name a function-like node: declaration, method, or the binding it is assigned to. */
function functionName(fn: ts.SignatureDeclarationBase): string | undefined {
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name) {
    return ts.isIdentifier(fn.name) ? fn.name.text : undefined;
  }
  let cur: ts.Node = fn;
  // Walk up through `(…)`, `a ?? (k) => …`, `a || …` wrappers.
  while (
    cur.parent &&
    (ts.isParenthesizedExpression(cur.parent) ||
      (ts.isBinaryExpression(cur.parent) &&
        (cur.parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
          cur.parent.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
        cur.parent.right === cur))
  ) {
    cur = cur.parent;
  }
  const p = cur.parent;
  if (!p) return undefined;
  if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  if (ts.isPropertyDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) return p.name.text;
  if (
    ts.isBinaryExpression(p) &&
    p.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isPropertyAccessExpression(p.left)
  ) {
    return p.left.name.text;
  }
  return undefined;
}

function isFunctionLike(n: ts.Node): n is ts.SignatureDeclarationBase & { body?: ts.Node } {
  return (
    ts.isFunctionDeclaration(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isArrowFunction(n) ||
    ts.isFunctionExpression(n)
  );
}

/** True when `call` is `<…config…>.get(…)` / `.getOrThrow(…)` (Nest ConfigService). */
function isConfigGet(call: ts.CallExpression, sf: ts.SourceFile): boolean {
  const callee = unwrap(call.expression);
  return (
    ts.isPropertyAccessExpression(callee) &&
    (callee.name.text === 'get' || callee.name.text === 'getOrThrow') &&
    /config/i.test(callee.expression.getText(sf)) &&
    call.arguments.length > 0
  );
}

/**
 * Find env-reading helpers: functions with a parameter that is used as a
 * process.env key, as a ConfigService.get key, or forwarded to another helper
 * (transitively, to a fixed point). `known` seeds the set with helpers
 * imported from other files.
 */
export function findEnvHelpers(sf: ts.SourceFile, known: readonly HelperSig[] = []): HelperSig[] {
  const helpers = new Map<string, Set<number>>();
  for (const h of known) {
    const s = helpers.get(h.name) ?? new Set<number>();
    s.add(h.paramIndex);
    helpers.set(h.name, s);
  }
  const fns: Array<{ name: string; params: string[]; body: ts.Node }> = [];
  const collect = (node: ts.Node): void => {
    if (isFunctionLike(node) && node.body) {
      const name = functionName(node);
      const params = node.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : ''));
      if (name && params.some(Boolean)) fns.push({ name, params, body: node.body });
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);

  const out = new Map<string, Set<number>>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const fn of fns) {
      const used = new Set<number>();
      const markIdent = (e: ts.Expression | undefined): void => {
        if (!e) return;
        const a = unwrap(e);
        if (ts.isIdentifier(a)) {
          const idx = fn.params.indexOf(a.text);
          if (idx >= 0) used.add(idx);
        }
      };
      const scan = (n: ts.Node): void => {
        if (ts.isElementAccessExpression(n) && isProcessEnvExpr(n.expression)) {
          markIdent(n.argumentExpression);
        }
        if (ts.isCallExpression(n)) {
          if (isConfigGet(n, sf)) markIdent(n.arguments[0]);
          const cn = calleeName(n);
          const idxs = cn ? (helpers.get(cn) ?? out.get(cn)) : undefined;
          if (idxs) for (const i of idxs) markIdent(n.arguments[i]);
        }
        ts.forEachChild(n, scan);
      };
      scan(fn.body);
      const prev = out.get(fn.name) ?? new Set<number>();
      for (const i of used) {
        if (!prev.has(i)) {
          prev.add(i);
          changed = true;
        }
      }
      if (prev.size > 0) out.set(fn.name, prev);
    }
  }
  const result: HelperSig[] = [];
  for (const [name, idxs] of out) for (const i of idxs) result.push({ name, paramIndex: i });
  return result;
}

function importedNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause) continue;
    const nb = st.importClause.namedBindings;
    if (nb && ts.isNamedImports(nb)) {
      for (const el of nb.elements) names.add((el.propertyName ?? el.name).text);
    }
  }
  return names;
}

function calleeName(call: ts.CallExpression): string | undefined {
  const c = unwrap(call.expression);
  if (ts.isIdentifier(c)) return c.text;
  if (ts.isPropertyAccessExpression(c)) return c.name.text;
  return undefined;
}

/** Parameters / variables that alias process.env inside this file. */
function processEnvAliases(sf: ts.SourceFile): Set<string> {
  const aliases = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
      const typeText = node.type ? node.type.getText(sf) : '';
      if (
        /ProcessEnv/.test(typeText) ||
        (node.initializer !== undefined && isProcessEnvExpr(node.initializer))
      ) {
        aliases.add(node.name.text);
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isProcessEnvExpr(node.initializer)
    ) {
      aliases.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return aliases;
}

/**
 * Scan one source file. `globalHelpers` are exported helpers found in other
 * files; they apply only when this file imports the helper by name.
 */
export function scanEnvReadsInSource(
  content: string,
  relPath: string,
  globalHelpers: readonly HelperSig[] = [],
): FileEnvScan {
  const sf = ts.createSourceFile(relPath, content, ts.ScriptTarget.Latest, true);
  const names = new Set<string>();
  const dynamic: DynamicEnvSite[] = [];
  const resolve = makeResolver(sf);
  const add = (n: string): void => {
    if (ENV_VAR_NAME.test(n)) names.add(n);
  };
  const addResolved = (expr: ts.Expression): void => {
    const r = resolve(expr);
    if (r.kind === 'names') r.names.forEach(add);
    else {
      const line = sf.getLineAndCharacterOfPosition(expr.getStart(sf)).line + 1;
      dynamic.push({ file: relPath, line, expr: unwrap(expr).getText(sf) });
    }
  };

  // 1) Direct process.env access (shared with env-discovery).
  for (const n of extractEnvVarRefs(content, relPath)) add(n);

  const imported = importedNames(sf);
  const importedHelpers = globalHelpers.filter((h) => imported.has(h.name));
  const localHelpers = findEnvHelpers(sf, importedHelpers);
  const helpers = new Map<string, number[]>();
  for (const h of [...localHelpers, ...importedHelpers]) {
    const list = helpers.get(h.name) ?? [];
    if (!list.includes(h.paramIndex)) list.push(h.paramIndex);
    helpers.set(h.name, list);
  }
  const aliases = processEnvAliases(sf);

  const helperParamNames = new Set<string>();
  const collectHelperParams = (node: ts.Node): void => {
    if (isFunctionLike(node)) {
      const nm = functionName(node);
      if (nm && localHelpers.some((h) => h.name === nm)) {
        for (const h of localHelpers.filter((x) => x.name === nm)) {
          const p = node.parameters[h.paramIndex];
          if (p && ts.isIdentifier(p.name)) helperParamNames.add(p.name.text);
        }
      }
    }
    ts.forEachChild(node, collectHelperParams);
  };
  collectHelperParams(sf);

  const visit = (node: ts.Node): void => {
    // Dynamic process.env[expr] that is not a helper parameter / resolvable key.
    if (ts.isElementAccessExpression(node) && isProcessEnvExpr(node.expression)) {
      const arg = unwrap(node.argumentExpression);
      const isHelperParam = ts.isIdentifier(arg) && helperParamNames.has(arg.text);
      if (!isHelperParam) {
        const r = resolve(arg);
        if (r.kind === 'names') r.names.forEach(add);
        else {
          const line = sf.getLineAndCharacterOfPosition(arg.getStart(sf)).line + 1;
          dynamic.push({ file: relPath, line, expr: arg.getText(sf) });
        }
      }
    }
    // ProcessEnv alias access: env.X / env['X'].
    if (ts.isPropertyAccessExpression(node)) {
      const recv = unwrap(node.expression);
      if (ts.isIdentifier(recv) && aliases.has(recv.text)) add(node.name.text);
    }
    if (ts.isElementAccessExpression(node)) {
      const recv = unwrap(node.expression);
      if (ts.isIdentifier(recv) && aliases.has(recv.text)) {
        const r = resolve(node.argumentExpression);
        if (r.kind === 'names') r.names.forEach(add);
      }
    }
    if (ts.isCallExpression(node)) {
      // ConfigService.get / getOrThrow (a helper's own parameter is resolved at
      // the helper's call sites instead).
      if (isConfigGet(node, sf)) {
        const a = unwrap(node.arguments[0]);
        if (!(ts.isIdentifier(a) && helperParamNames.has(a.text))) addResolved(node.arguments[0]);
      }
      // Env-reading helpers.
      const cn = calleeName(node);
      const idxs = cn ? helpers.get(cn) : undefined;
      if (idxs) {
        for (const idx of idxs) {
          const arg = node.arguments[idx];
          if (!arg) continue;
          // A helper forwarding its own parameter to another helper is not a
          // new read site — the outer call site resolves it.
          const a = unwrap(arg);
          if (ts.isIdentifier(a) && helperParamNames.has(a.text)) continue;
          addResolved(arg);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { names, dynamic };
}

/** True for runtime source files in scope (non-test TypeScript). */
export function isRuntimeSource(rel: string): boolean {
  if (!rel.endsWith('.ts') || rel.endsWith('.d.ts')) return false;
  if (/\.spec\.ts$|\.test\.ts$/.test(rel)) return false;
  if (rel.split(path.sep).includes('__tests__') || rel.split('/').includes('__tests__')) {
    return false;
  }
  return true;
}

function walk(dir: string, out: string[]): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
}

/** Scan every runtime .ts file under <repoRoot>/src. */
export function scanEnvReads(repoRoot: string): EnvReadScan {
  const files: string[] = [];
  walk(path.join(repoRoot, 'src'), files);
  const rels = files
    .map((f) => path.relative(repoRoot, f).split(path.sep).join('/'))
    .filter(isRuntimeSource)
    .sort();
  const contents = new Map<string, string>();
  for (const r of rels) contents.set(r, fs.readFileSync(path.join(repoRoot, r), 'utf8'));

  // Pass 1: exported helpers usable from other files.
  const globalHelpers: HelperSig[] = [];
  for (const [rel, content] of contents) {
    if (!/\bexport\b/.test(content)) continue;
    const sf = ts.createSourceFile(rel, content, ts.ScriptTarget.Latest, true);
    const exported = new Set<string>();
    for (const st of sf.statements) {
      const mods = ts.canHaveModifiers(st) ? ts.getModifiers(st) : undefined;
      const isExported = mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
      if (!isExported) continue;
      if (ts.isFunctionDeclaration(st) && st.name) exported.add(st.name.text);
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (ts.isIdentifier(d.name)) exported.add(d.name.text);
        }
      }
    }
    for (const h of findEnvHelpers(sf)) if (exported.has(h.name)) globalHelpers.push(h);
  }

  const reads = new Map<string, string[]>();
  const dynamic: DynamicEnvSite[] = [];
  for (const [rel, content] of contents) {
    const r = scanEnvReadsInSource(content, rel, globalHelpers);
    for (const n of r.names) reads.set(n, [...(reads.get(n) ?? []), rel]);
    dynamic.push(...r.dynamic);
  }
  return { reads, dynamic };
}

/** Result of checking scanned reads against the ENV_RULES registry. */
export interface RegistrationReport {
  registered: Set<string>;
  /** Names read by src/ but absent from ENV_RULES (the red lines). */
  unregistered: Array<{ name: string; files: string[] }>;
  /** Dynamic read sites not recorded in DYNAMIC_ENV_SITES. */
  unknownDynamic: DynamicEnvSite[];
  /** DYNAMIC_ENV_SITES names that are themselves unregistered. */
  unregisteredDynamicNames: string[];
  /** DYNAMIC_ENV_SITES keys that no longer match any dynamic site (stale). */
  staleDynamicSites: string[];
  /** Registered names nothing in src/ reads (informational only). */
  registeredUnread: string[];
  readCount: number;
}

/** Cross a scan with the registry. Pure (registry names passed in). */
export function checkRegistration(
  scan: EnvReadScan,
  registryNames: Iterable<string>,
  dynamicSites: Readonly<Record<string, readonly string[]>> = DYNAMIC_ENV_SITES,
): RegistrationReport {
  const registered = new Set(registryNames);
  const unregistered = [...scan.reads.entries()]
    .filter(([n]) => !registered.has(n))
    .map(([name, files]) => ({ name, files }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const unknownDynamic = scan.dynamic.filter((d) => !(`${d.file}::${d.expr}` in dynamicSites));
  const unregisteredDynamicNames = [
    ...new Set(Object.values(dynamicSites).flatMap((ns) => ns.filter((n) => !registered.has(n)))),
  ].sort();
  const seenSites = new Set(scan.dynamic.map((d) => `${d.file}::${d.expr}`));
  const staleDynamicSites = Object.keys(dynamicSites)
    .filter((k) => !seenSites.has(k))
    .sort();
  const dynamicNames = new Set(Object.values(dynamicSites).flat());
  const registeredUnread = [...registered]
    .filter((n) => !scan.reads.has(n) && !dynamicNames.has(n))
    .sort();
  return {
    registered,
    unregistered,
    unknownDynamic,
    unregisteredDynamicNames,
    staleDynamicSites,
    registeredUnread,
    readCount: scan.reads.size,
  };
}

/** End-to-end: scan <repoRoot>/src and check against its env-validation.ts. */
export function checkRepoRegistration(repoRoot: string): RegistrationReport {
  const registry = extractEnvRuleNames(path.join(repoRoot, 'src/common/env-validation.ts'));
  return checkRegistration(scanEnvReads(repoRoot), registry);
}

/** Red-line count for the board: unregistered reads + unrecorded dynamic sites. */
export function registrationRedCount(r: RegistrationReport): number {
  return (
    r.unregistered.length +
    r.unknownDynamic.length +
    r.unregisteredDynamicNames.length +
    r.staleDynamicSites.length
  );
}
