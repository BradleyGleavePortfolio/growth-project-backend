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
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'ENV_RULES') {
      if (node.initializer && ts.isArrayLiteralExpression(node.initializer)) {
        collectFromArray(node.initializer);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...names];
}

/**
 * Extract every statically-knowable env-var name referenced in one source
 * file, across all four access shapes. Identifier-keyed element accesses are
 * resolved against string `const`s declared in the same file.
 */
export function extractEnvVarRefs(content: string, fileName = 'inline.ts'): Set<string> {
  const sf = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  const found = new Set<string>();
  const stringConsts = collectStringConsts(sf);

  const isProcessEnv = (node: ts.Expression): boolean =>
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'process' &&
    node.name.text === 'env';

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
        if (ts.isIdentifier(key)) add(key.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** Map of `const X = '<string>'` declarations (string-valued only). */
function collectStringConsts(sf: ts.SourceFile): Map<string, string> {
  const map = new Map<string, string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isStringLiteralLike(node.initializer)
    ) {
      map.set(node.name.text, node.initializer.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return map;
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
function walkTs(dir: string, visit: (file: string) => void, visited: Set<string> = new Set()): void {
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
