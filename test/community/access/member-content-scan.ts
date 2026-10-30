/**
 * Test-only helper for member-content-access.spec.ts (KT-2 in KNOWN_TRAPS.md).
 *
 * It reads prisma/schema.prisma and every runtime file under src/ (never a spec, a __tests__ file or a
 * test helper) and lists each place that READS a member-content table:
 *   prisma    a Prisma read call on the model (findMany, findFirst, findUnique, count, groupBy, aggregate and
 *             their OrThrow forms), however the delegate is reached: `x.communityPost`, `x['communityPost']`,
 *             `x[KEY]` with KEY a string constant, `const { communityPost } = x`, on any receiver (only the
 *             ambiguous `message` delegate still needs a receiver named like a client: prisma, tx, db, ...);
 *   sql       a SQL string that reads the table: FROM or JOIN it, a schema-qualified or quoted name, or a FROM
 *             list (`FROM users u, community_messages m`);
 *   relation  a relation field of a member-content model in `include` or `select`, in any object literal that
 *             reads like a Prisma argument (`{ community_messages_sent: true }`), or held in a constant, a spread,
 *             a `?:` / `??` branch or a function's return (the scan follows each to its initializer), or a fluent
 *             relation read (`findUnique(...).community_messages_sent()`);
 *   aliased   the delegate kept in a variable, passed along, destructured, or named in a string ('communityWin'
 *             handed to a generic reader);
 *   dynamic   FAIL CLOSED: a read the scan cannot tie to one model (a delegate picked by a runtime key, a table
 *             named through Prisma.raw or a ${} after FROM/JOIN, also schema-qualified with or without quotes
 *             (`FROM public.${...}`, `FROM "public".${...}`), SQL built at runtime for $queryRawUnsafe, an include or
 *             select whose value or key the scan cannot follow, `{ [relation]: true }` with a runtime key). The
 *             site's model is ANY_MODEL ('*'); the registry must list the reader with '*' and say what it reads;
 *   caller    a reference to a reader that leaves the rules to its caller, from another function: every repository
 *             reader (a *Repository class method that reads a model, passesRowsOn), every registry row that lists
 *             `callers` (ScanOptions.passThrough: MessagingService.listThread), and, to a fixed point, every
 *             repository method that wraps one (same class or not). One TypeScript program over src/ resolves the
 *             reference with the checker: import aliases, `this.x` and getter types, untyped locals, `const { x } =
 *             this`, destructured methods, `x['name']` and `x[NAME]`, `.call` / `.apply` / `.bind`, subclasses, and
 *             an interface or abstract member (each passing reader whose class fits the receiver type). FAIL CLOSED
 *             (callee `?.name`, model '*'): a passing reader's name on a value typed `any`, and a computed key on a
 *             value whose type holds a passing reader. The caller is a read site unless the reader's row lists it
 *             in `callers` (LO-1185 B3, LS-1185R2 B1, LO-1185R2 B2 and C1).
 * Writes (create, update, upsert, delete) are not reads and are not listed. A write that returns rows is a
 * write here; the registry still lists the function when it also reads.
 *
 * Limits (each shown by a test in member-content-access.spec.ts, 'the scan limits'):
 *   L1 the program loads no lib and no node_modules (speed: one program over src/ in about 10 s), so a value whose
 *      type comes from a package or a built-in (`moduleRef.get(Repo)`, a string method's result) is unresolved,
 *      not `any`; a reader's name called on it is not seen (failing closed there flags Supabase storage `list`
 *      and String `search`, a false read on every package call named like a reader);
 *   L2 a reader named only at runtime (`Reflect.get(repo, name)`, a generic invoker taking the method name as a
 *      string) is not seen;
 *   L3 a method outside a *Repository class that hands a reader's rows on is a pass-through only when its row
 *      declares `callers` (structurally every service method returns rows, so the scan cannot tell a method that
 *      applied the rules from one that did not);
 *   L4 a reader's rows kept in a field or a closure and read by another method are not traced (only the reference
 *      to the reader is a site);
 *   L5 SQL assembled from string concatenation outside an Unsafe call is matched piece by piece.
 *
 * Nothing here changes runtime code or the schema; both are only read.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';
import * as ts from 'typescript';

export const REPO_ROOT = join(__dirname, '..', '..', '..');

/** Prisma model -> the reason it holds member-authored content or a trace of it. */
export const MEMBER_CONTENT_MODELS: Record<string, string> = {
  CommunityMessage: 'space chat, replies, direct messages and voice-message rows',
  CommunityPost: 'Hall and space posts and their comments',
  CommunityResponse: 'reactions: who reacted to which member item',
  CommunityVoiceNote: 'voice notes (audio key, waveform) in spaces and direct messages',
  CommunityVoiceNoteListen: 'who listened to which voice note',
  CommunityMessageImage: 'photos attached to space messages',
  CommunitySearchEntry: 'search excerpts, including voice-note transcripts',
  CommunityWin: 'wins a member shares',
  CommunityChallengeParticipation: 'challenge progress rows shown on the leaderboard',
  CommunityModerationAction: 'reports: the reported member item and the reporter reason',
  CoachMessage: 'coach and client one-to-one messages and voice messages',
  Message: 'legacy one-to-one messages',
  MessageReport: 'reports on a one-to-one message',
};

/** The model of a `dynamic` site: the scan cannot tell which table it reads, so the registry must say. */
export const ANY_MODEL = '*';

export const READ_METHODS = new Set([
  'findMany',
  'findFirst',
  'findUnique',
  'findFirstOrThrow',
  'findUniqueOrThrow',
  'count',
  'groupBy',
  'aggregate',
]);

export const WRITE_METHODS = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
  'fields',
]);

/** Keys that make an object literal read like a Prisma relation argument (`{ replies: { where, select } }`). */
const RELATION_ARG_KEYS = new Set(['select', 'include', 'where', 'orderBy', 'take', 'skip', 'cursor', 'distinct']);

export interface ReadSite {
  /** Repo-relative path with forward slashes, e.g. src/community/messages/community-messages.repository.ts */
  file: string;
  line: number;
  /** Enclosing reader: Class.method, a top-level function or const, or <module>. */
  reader: string;
  /** A member-content model, or ANY_MODEL for a `dynamic` site. */
  model: string;
  via: 'prisma' | 'sql' | 'aliased' | 'relation' | 'dynamic' | 'caller';
  /** For a `caller` site: the repository reader it calls, as `Class.method`. */
  callee?: string;
}

/** Model name -> { delegate (camelCase Prisma client key), table (the @@map name or the model name) }. */
export function memberContentTables(
  schemaPath = join(REPO_ROOT, 'prisma', 'schema.prisma'),
): Record<string, { delegate: string; table: string }> {
  const schema = readFileSync(schemaPath, 'utf8');
  const out: Record<string, { delegate: string; table: string }> = {};
  for (const model of Object.keys(MEMBER_CONTENT_MODELS)) {
    const block = new RegExp(`^model ${model} \\{([\\s\\S]*?)^\\}`, 'm').exec(schema);
    if (!block) throw new Error(`member-content-scan: model ${model} is not in prisma/schema.prisma (renamed?)`);
    const map = /@@map\("([^"]+)"\)/.exec(block[1]);
    out[model] = { delegate: model[0].toLowerCase() + model.slice(1), table: map ? map[1] : model };
  }
  return out;
}

/** Relation field name -> member-content model, for `include: { field }` and `select: { field }` reads. */
export function memberContentRelations(
  schemaPath = join(REPO_ROOT, 'prisma', 'schema.prisma'),
): Map<string, string> {
  const models = Object.keys(MEMBER_CONTENT_MODELS).join('|');
  // Field lines only: indentation is spaces or tabs, never a newline (N1 of LO-1185).
  const re = new RegExp(`^[ \\t]+(\\w+)[ \\t]+(${models})(\\[\\]|\\?)?([ \\t]|$)`, 'gm');
  const out = new Map<string, string>();
  for (const m of readFileSync(schemaPath, 'utf8').matchAll(re)) {
    const prev = out.get(m[1]);
    out.set(m[1], prev && !prev.split('|').includes(m[2]) ? `${prev}|${m[2]}` : m[2]);
  }
  return out;
}

/** A SQL text reads `table`: FROM / JOIN it (optionally schema-qualified and quoted), also later in a FROM list. */
export function sqlReadsTable(table: string): RegExp {
  const name = `(?:"?public"?\\.)?"?${table}"?`;
  const listed = `(?:(?:"?\\w+"?\\.)?"?\\w+"?(?:[ \\t\\n]+(?:as[ \\t\\n]+)?"?\\w+"?)?[ \\t\\n]*,[ \\t\\n]*)*`;
  return new RegExp(`\\b(from|join)[ \\t\\n]+${listed}${name}(?![A-Za-z0-9_])`, 'i');
}

/**
 * A SQL text whose table comes from a ${} right after FROM / JOIN (or a FROM-list comma), also after a schema,
 * quoted or not (`FROM public.${t}`, `FROM "public".${t}`, `JOIN "public"."${t}"`; LS-1185R2 B2).
 */
export const SQL_DYNAMIC_TABLE = /\b(from|join)[ \t\n]+(?:[^;()]*?,[ \t\n]*)?(?:"?\w+"?[ \t\n]*\.[ \t\n]*)?"?$/i;

/** A template that is SQL: a tagged $queryRaw / $executeRaw / Prisma.sql / sql template, or a Prisma.raw or Unsafe argument. */
function inSql(node: ts.Node): boolean {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isTaggedTemplateExpression(n)) return /(\$(query|execute)Raw\w*|(^|\.)sql)$/i.test(n.tag.getText());
    if (ts.isCallExpression(n)) return /(\$(query|execute)RawUnsafe|Prisma\.raw|(^|\.)sql)$/.test(n.expression.getText());
  }
  return false;
}

function runtimeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === '__tests__' || name === '__mocks__' || name === '__fixtures__' || name === 'node_modules') continue;
      out.push(...runtimeFiles(p));
    } else if (/\.ts$/.test(name) && !/\.(spec|test)\.ts$/.test(name) && !/\.d\.ts$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

function nameOf(n: ts.Node | undefined): string | undefined {
  if (!n) return undefined;
  if (ts.isIdentifier(n) || ts.isPrivateIdentifier(n) || ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
    return n.text;
  }
  return undefined;
}

/** Class.member for code inside a class; otherwise the top-level function or const; otherwise <module>. */
function readerOf(node: ts.Node): string {
  let topLevel: string | undefined;
  for (let n: ts.Node | undefined = node; n; n = n.parent) {
    if (
      (ts.isMethodDeclaration(n) || ts.isPropertyDeclaration(n) || ts.isGetAccessorDeclaration(n) ||
        ts.isConstructorDeclaration(n)) &&
      n.parent && (ts.isClassDeclaration(n.parent) || ts.isClassExpression(n.parent))
    ) {
      const member = ts.isConstructorDeclaration(n) ? 'constructor' : nameOf(n.name) ?? '<computed>';
      return `${nameOf(n.parent.name) ?? '<class>'}.${member}`;
    }
    if (ts.isFunctionDeclaration(n) && n.parent && ts.isSourceFile(n.parent)) topLevel = nameOf(n.name);
    if (ts.isVariableDeclaration(n) && n.parent?.parent?.parent && ts.isSourceFile(n.parent.parent.parent)) {
      topLevel = nameOf(n.name);
    }
  }
  return topLevel ?? '<module>';
}

function classOf(node: ts.Node): ts.ClassLikeDeclaration | undefined {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) if (ts.isClassLike(n)) return n;
  return undefined;
}

const unwrap = (e: ts.Expression): ts.Expression => {
  let x = e;
  while (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isNonNullExpression(x) ||
    ts.isTypeAssertionExpression(x) || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(x))) {
    x = (x as ts.ParenthesizedExpression).expression;
  }
  return x;
};

/** The class member a node is in (method, property, accessor, constructor): the one readerOf names. */
function memberOf(node: ts.Node): ts.ClassElement | undefined {
  for (let n: ts.Node | undefined = node; n; n = n.parent) {
    if (
      (ts.isMethodDeclaration(n) || ts.isPropertyDeclaration(n) || ts.isGetAccessorDeclaration(n) ||
        ts.isConstructorDeclaration(n)) &&
      n.parent && ts.isClassLike(n.parent)
    ) {
      return n;
    }
  }
  return undefined;
}

/**
 * A member that passes the rows it reads on to its caller by its shape: a member of a *Repository class (a
 * repository applies none of the four rules). Any other reader that does is declared by its registry row's
 * `callers` (ScanOptions.passThrough; MessagingService.listThread, LO-1185R2 C1).
 */
export function passesRowsOn(member: ts.ClassElement | undefined): boolean {
  return !!member?.parent && ts.isClassLike(member.parent) && /Repository$/.test(nameOf(member.parent.name) ?? '');
}

/** One program over the scanned files: the checker resolves receivers, aliases and imports between them. */
const PROGRAM_OPTIONS: ts.CompilerOptions = {
  noResolve: true, // only the scanned files: an import from a package stays untyped (a limit, named above)
  noLib: true,
  types: [],
  noEmit: true,
  target: ts.ScriptTarget.ES2021,
  module: ts.ModuleKind.CommonJS,
  moduleResolution: ts.ModuleResolutionKind.Node10,
  experimentalDecorators: true,
  strict: true,
};

function programOver(files: string[]): ts.Program {
  return ts.createProgram({ rootNames: files, options: PROGRAM_OPTIONS, host: ts.createCompilerHost(PROGRAM_OPTIONS, true) });
}

/** `any` as written or inferred in the scanned code (not the error type of an import from a package). */
const isAny = (t: ts.Type | undefined): boolean =>
  !!t && (t.flags & ts.TypeFlags.Any) !== 0 && (t as { intrinsicName?: string }).intrinsicName === 'any';

/** A value an include or select may hold without naming a relation: true, false, a string, a number, nothing. */
const PLAIN = ts.TypeFlags.BooleanLike | ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.Null |
  ts.TypeFlags.Undefined | ts.TypeFlags.Void;

export interface ScanOptions {
  /**
   * Readers (`Class.method`) that pass their rows on besides those passesRowsOn shows: every registry row that
   * lists `callers` (member-content-readers.ts). A public method of any class that hands its reader's rows to its
   * own callers is declared there.
   */
  passThrough?: Iterable<string>;
}

interface Parsed {
  abs: string;
  file: string;
  sf: ts.SourceFile;
}

/** A reference to a class member by name: `x.name`, `x['name']`, `x[NAME]`, `const { name } = x`. */
interface Ref {
  file: string;
  sf: ts.SourceFile;
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression | ts.BindingElement;
  name?: string;
  reader: string;
  member?: ts.ClassElement;
}

/** Every read of a member-content table in runtime code under src/. */
export function scanMemberContentReads(srcRoot = join(REPO_ROOT, 'src'), options: ScanOptions = {}): ReadSite[] {
  const tables = memberContentTables();
  const relations = memberContentRelations();
  const byDelegate = new Map(Object.entries(tables).map(([model, t]) => [t.delegate, model]));
  const sqlTables = Object.entries(tables).map(([model, t]) => ({ model, re: sqlReadsTable(t.table) }));
  const looksLikeClient = (text: string) => /(^|\.)(prisma|tx|trx|db|client)$/i.test(text) || /prisma/i.test(text);
  // A receiver that is a Prisma client itself (for `client[key]`): prisma, this.prisma, tx, db, ...
  const isClient = (text: string) => /(^|\.)(prisma|prismaService|tx|trx|db|client)$/i.test(text);
  const sites: ReadSite[] = [];
  /** The class member of each site found below, by index (for the callers pass). */
  const siteMembers: Array<ts.ClassElement | undefined> = [];
  const files = runtimeFiles(srcRoot);
  const program = programOver(files);
  const checker = program.getTypeChecker();
  const parsed: Parsed[] = files.map((abs) => ({
    abs,
    file: relative(REPO_ROOT, abs).split(sep).join('/'),
    sf: program.getSourceFile(abs) ??
      ts.createSourceFile(abs, readFileSync(abs, 'utf8'), ts.ScriptTarget.ES2021, true, ts.ScriptKind.TS),
  }));
  /** A string key the checker can name: a literal, a constant of any scanned file, an `as const` member. */
  const literalKey = (e: ts.Expression): string | undefined => {
    const k = unwrap(e);
    if (ts.isStringLiteral(k) || ts.isNoSubstitutionTemplateLiteral(k)) return k.text;
    if (ts.isNumericLiteral(k)) return undefined;
    const t = checker.getTypeAtLocation(k);
    return t.isStringLiteral() ? t.value : undefined;
  };

  for (const { file, sf } of parsed) {
    const add = (node: ts.Node, model: string, via: ReadSite['via'], callee?: string) => {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      sites.push({ file, line, reader: readerOf(node), model, via, ...(callee ? { callee } : {}) });
      siteMembers.push(memberOf(node));
    };
    // String constants of this file (`const KEY = 'communityMessage'`), so `x[KEY]` resolves.
    const constants = new Map<string, string>();
    const collect = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
        const init = unwrap(n.initializer);
        if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) constants.set(n.name.text, init.text);
      }
      ts.forEachChild(n, collect);
    };
    collect(sf);
    const keyOf = (e: ts.Expression): string | undefined => {
      const k = unwrap(e);
      if (ts.isIdentifier(k) && constants.has(k.text)) return constants.get(k.text);
      return literalKey(k);
    };
    /** An identifier of `sym` written after its initializer: reassigned, a key set on it, Object.assign into it. */
    const changedLater = (sym: ts.Symbol, d: ts.VariableDeclaration): boolean => {
      const scope = ts.findAncestor(d.parent, (n) => ts.isBlock(n) || ts.isSourceFile(n)) ?? d.getSourceFile();
      let changed = false;
      const look = (n: ts.Node): void => {
        if (changed) return;
        if (ts.isIdentifier(n) && n !== d.name && checker.getSymbolAtLocation(n) === sym) {
          const p = n.parent;
          const assigned = (e: ts.Node) => ts.isBinaryExpression(e.parent) && e.parent.left === e &&
            e.parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && e.parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
          if (assigned(n)) changed = true;
          if ((ts.isElementAccessExpression(p) || ts.isPropertyAccessExpression(p)) && p.expression === n && assigned(p)) changed = true;
          if (ts.isCallExpression(p) && p.arguments[0] === n && /(^|\.)assign$/.test(p.expression.getText())) changed = true;
        }
        ts.forEachChild(n, look);
      };
      look(scope);
      return changed;
    };
    type Held = { models: string[]; unknown: boolean };
    const both = (a: Held, b: Held): Held => ({ models: [...a.models, ...b.models], unknown: a.unknown || b.unknown });
    const UNKNOWN: Held = { models: [], unknown: true };
    /** A constant's include or select, read at its initializer (a constant changed later is unknown). */
    const heldBy = (symbol: ts.Symbol | undefined, depth: number): Held => {
      let sym = symbol;
      if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
      const d = sym?.valueDeclaration;
      if (!sym || !d) return UNKNOWN;
      if ((ts.isVariableDeclaration(d) || ts.isPropertyAssignment(d) || ts.isPropertyDeclaration(d)) && d.initializer) {
        const held = argReads(d.initializer, depth + 1);
        return ts.isVariableDeclaration(d) && changedLater(sym, d) ? { ...held, unknown: true } : held;
      }
      if (ts.isShorthandPropertyAssignment(d)) return heldBy(checker.getShorthandAssignmentValueSymbol(d), depth + 1);
      return UNKNOWN;
    };
    /**
     * What an include or select value reads (LS-1185R2 B2): the member-content relations it names, through
     * constants, spreads, `a ? b : c` and `a ?? b`; unknown when a key or a value cannot be followed.
     */
    const argReads = (expr: ts.Expression, depth: number): Held => {
      const v = unwrap(expr);
      if (depth > 8) return UNKNOWN;
      if (ts.isObjectLiteralExpression(v)) {
        let out: Held = { models: [], unknown: false };
        for (const p of v.properties) {
          if (ts.isSpreadAssignment(p)) {
            out = both(out, argReads(p.expression, depth + 1));
            continue;
          }
          const key = ts.isComputedPropertyName(p.name) ? keyOf(p.name.expression) : nameOf(p.name);
          if (key === undefined) {
            out = { ...out, unknown: true };
            continue;
          }
          const off = ts.isPropertyAssignment(p) && unwrap(p.initializer).kind === ts.SyntaxKind.FalseKeyword;
          if (relations.has(key) && !off) out = both(out, { models: (relations.get(key) as string).split('|'), unknown: false });
        }
        return out;
      }
      if (ts.isConditionalExpression(v)) return both(argReads(v.whenTrue, depth + 1), argReads(v.whenFalse, depth + 1));
      if (ts.isBinaryExpression(v) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.AmpersandAmpersandToken].includes(v.operatorToken.kind)) {
        return both(argReads(v.left, depth + 1), argReads(v.right, depth + 1));
      }
      if (ts.isIdentifier(v) || ts.isPropertyAccessExpression(v)) {
        const held = heldBy(checker.getSymbolAtLocation(ts.isIdentifier(v) ? v : v.name), depth);
        if (!held.unknown || held.models.length > 0) return held;
      }
      // A function or method of the scanned code that builds it (`select: this.chargeSelect()`): what it returns.
      if (ts.isCallExpression(v)) {
        const callee = unwrap(v.expression);
        let sym = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(callee) ? callee.name : callee);
        if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
        let fn: ts.Node | undefined = sym?.valueDeclaration;
        if (fn && ts.isVariableDeclaration(fn) && fn.initializer) fn = unwrap(fn.initializer);
        if (fn && (ts.isMethodDeclaration(fn) || ts.isFunctionDeclaration(fn) || ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && fn.body) {
          if (!ts.isBlock(fn.body)) return argReads(fn.body, depth + 1);
          let out: Held | undefined;
          const returns = (n: ts.Node): void => {
            if (ts.isReturnStatement(n)) out = both(out ?? { models: [], unknown: false }, n.expression ? argReads(n.expression, depth + 1) : UNKNOWN);
            if (!ts.isFunctionLike(n)) ts.forEachChild(n, returns);
          };
          ts.forEachChild(fn.body, returns);
          if (out) return out;
        }
      }
      if (checker.getTypeAtLocation(v).flags & PLAIN) return { models: [], unknown: false };
      return UNKNOWN;
    };
    const isStaticKey = (e: ts.Expression): boolean => {
      const k = unwrap(e);
      return ts.isNumericLiteral(k) || ts.isPrefixUnaryExpression(k);
    };
    /** `delegateNode` reaches `model`'s delegate: a read call, a write call, or an alias. */
    const delegateUse = (delegateNode: ts.Expression, model: string, receiver: ts.Expression, ambiguous: boolean) => {
      const parent = delegateNode.parent;
      const method = parent && ts.isPropertyAccessExpression(parent) && parent.expression === delegateNode ? parent.name.text : undefined;
      if (method && READ_METHODS.has(method)) add(delegateNode, model, 'prisma');
      else if (method && WRITE_METHODS.has(method)) {
        /* a write, not a read */
      } else if (ts.isCallExpression(parent) && parent.expression === delegateNode) {
        /* x.communityPost(...) is a method of that name, not the delegate */
      } else if (!ambiguous || looksLikeClient(unwrap(receiver).getText(sf))) add(delegateNode, model, 'aliased');
    };

    const visit = (node: ts.Node): void => {
      // x.communityPost...
      if (ts.isPropertyAccessExpression(node) && byDelegate.has(node.name.text)) {
        const model = byDelegate.get(node.name.text) as string;
        delegateUse(node, model, node.expression, model === 'Message');
      }
      // x['communityPost'], x[KEY], x[model]
      if (ts.isElementAccessExpression(node)) {
        const key = keyOf(node.argumentExpression);
        if (key !== undefined && byDelegate.has(key)) {
          const model = byDelegate.get(key) as string;
          delegateUse(node, model, node.expression, model === 'Message');
        } else if (key === undefined && !isStaticKey(node.argumentExpression)) {
          const parent = node.parent;
          const readCall = ts.isPropertyAccessExpression(parent) && READ_METHODS.has(parent.name.text) &&
            ts.isCallExpression(parent.parent) && parent.parent.expression === parent;
          if (readCall || isClient(unwrap(node.expression).getText(sf))) add(node, ANY_MODEL, 'dynamic');
        }
      }
      // const { communityPost } = x;  const { communityMessage: rows } = x;
      if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        const key = nameOf(node.propertyName ?? node.name);
        if (key && byDelegate.has(key)) {
          const model = byDelegate.get(key) as string;
          const decl = node.parent.parent;
          const from = ts.isVariableDeclaration(decl) && decl.initializer ? unwrap(decl.initializer).getText(sf) : '';
          if (model !== 'Message' || looksLikeClient(from)) add(node, model, 'aliased');
        }
      }
      // 'communityWin' handed to a generic reader (DataExportService._streamAll and the like)
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && byDelegate.has(node.text) &&
        node.text !== 'message' && !(ts.isElementAccessExpression(node.parent) && node.parent.argumentExpression === node)) {
        if (!ts.isImportDeclaration(node.parent) && !ts.isExportDeclaration(node.parent) && !ts.isLiteralTypeNode(node.parent)) {
          add(node, byDelegate.get(node.text) as string, 'aliased');
        }
      }
      // relation fields: include/select holders, Prisma-argument-like object literals, fluent reads
      const propKey = (n: ts.PropertyName): string | undefined =>
        ts.isComputedPropertyName(n) ? keyOf(n.expression) : nameOf(n);
      if (ts.isPropertyAssignment(node) && ts.isComputedPropertyName(node.name) && propKey(node.name) === undefined) {
        const holder = node.parent?.parent;
        if (holder && ts.isPropertyAssignment(holder) && ['include', 'select'].includes(nameOf(holder.name) ?? '')) {
          add(node, ANY_MODEL, 'dynamic');
        }
      }
      // LS-1185R2 B2: an include or select held in a constant or spread from one is followed to what it names, at
      // the read that uses it; one the scan cannot follow (a computed key, a parameter, a call) fails closed.
      if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && ts.isObjectLiteralExpression(node.parent) &&
        ['include', 'select'].includes(nameOf(node.name) ?? '')) {
        const value = ts.isPropertyAssignment(node) ? unwrap(node.initializer) : undefined;
        let held: Held | undefined;
        if (!value) held = heldBy(checker.getShorthandAssignmentValueSymbol(node), 0);
        else if (!ts.isObjectLiteralExpression(value)) held = argReads(value, 0);
        else {
          for (const p of value.properties) if (ts.isSpreadAssignment(p)) held = both(held ?? { models: [], unknown: false }, argReads(p.expression, 1));
        }
        if (held?.unknown) add(node, ANY_MODEL, 'dynamic');
        for (const model of new Set(held?.models ?? [])) add(node, model, 'relation');
      }
      if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && relations.has(propKey(node.name) ?? '')) {
        const relation = propKey(node.name) as string;
        const holder = node.parent?.parent;
        const inHolder = !!holder && ts.isPropertyAssignment(holder) && ['include', 'select'].includes(nameOf(holder.name) ?? '');
        let argLike = false;
        if (ts.isPropertyAssignment(node)) {
          const v = unwrap(node.initializer);
          argLike = v.kind === ts.SyntaxKind.TrueKeyword ||
            (ts.isObjectLiteralExpression(v) && v.properties.some((p) => RELATION_ARG_KEYS.has(nameOf(p.name) ?? '')));
        }
        if (inHolder || argLike) {
          for (const model of (relations.get(relation) as string).split('|')) add(node, model, 'relation');
        }
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        relations.has(node.expression.name.text) && ts.isCallExpression(unwrap(node.expression.expression))) {
        const inner = unwrap(node.expression.expression) as ts.CallExpression;
        const innerMethod = ts.isPropertyAccessExpression(inner.expression) ? inner.expression.name.text : '';
        if (READ_METHODS.has(innerMethod)) {
          for (const model of (relations.get(node.expression.name.text) as string).split('|')) add(node, model, 'relation');
        }
      }
      // SQL text
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
        for (const { model, re } of sqlTables) if (re.test(node.text)) add(node, model, 'sql');
        if ((ts.isTemplateHead(node) || ts.isTemplateMiddle(node)) && SQL_DYNAMIC_TABLE.test(node.text) && inSql(node)) {
          add(node, ANY_MODEL, 'dynamic');
        }
      }
      // SQL built at runtime for an Unsafe call
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        /^\$(query|execute)RawUnsafe$/.test(node.expression.name.text) && node.arguments.length > 0) {
        const sql = unwrap(node.arguments[0]);
        // A template is checked piece by piece above; anything else (a variable, a concatenation) is unknown SQL.
        if (!ts.isStringLiteral(sql) && !ts.isNoSubstitutionTemplateLiteral(sql) && !ts.isTemplateExpression(sql)) {
          add(node, ANY_MODEL, 'dynamic');
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  // Callers (LO-1185 B3; LS-1185R2 B1; LO-1185R2 B2, C1, C2). A reader that passes its rows on (passesRowsOn, or a
  // registry row with callers) leaves the rules to its caller, so every reference to it from another function is a
  // read site of that function. A function that passes those rows on in turn joins the set, until nothing changes.
  // The checker resolves each reference: import aliases, `this.x` and getter types, untyped locals, destructuring,
  // `x['name']` and `x[NAME]`, `.call` / `.apply` / `.bind` (the reference itself is the site), interfaces and
  // abstract members (every passing reader whose class fits the receiver's type). A reference by a passing reader's
  // name on a value typed `any`, or a computed key on a value whose type holds a passing reader, fails closed.
  const declared = new Set(options.passThrough ?? []);
  const passes = (reader: string, member: ts.ClassElement | undefined) => declared.has(reader) || passesRowsOn(member);
  const through = new Map<string, Set<string>>();
  const throughClass = new Map<string, ts.ClassLikeDeclaration>();
  const grow = (reader: string, member: ts.ClassElement | undefined, models: Iterable<string>): boolean => {
    if (!through.has(reader)) through.set(reader, new Set());
    if (member?.parent && ts.isClassLike(member.parent)) throughClass.set(reader, member.parent);
    const set = through.get(reader) as Set<string>;
    const before = set.size;
    for (const m of models) set.add(m);
    return set.size > before;
  };
  sites.forEach((s, i) => {
    if (passes(s.reader, siteMembers[i])) grow(s.reader, siteMembers[i], [s.model]);
  });
  const methodName = (reader: string) => reader.slice(reader.lastIndexOf('.') + 1);

  const refs: Ref[] = [];
  for (const { file, sf } of parsed) {
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node)) {
        refs.push({ file, sf, node, name: node.name.text, reader: readerOf(node), member: memberOf(node) });
      } else if (ts.isElementAccessExpression(node)) {
        const k = unwrap(node.argumentExpression);
        if (!ts.isNumericLiteral(k)) {
          refs.push({ file, sf, node, name: literalKey(k), reader: readerOf(node), member: memberOf(node) });
        }
      } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        const key = node.propertyName ?? node.name;
        const name = ts.isComputedPropertyName(key) ? literalKey(key.expression) : nameOf(key);
        refs.push({ file, sf, node, name, reader: readerOf(node), member: memberOf(node) });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  const declReader = (d: ts.Declaration): string | undefined =>
    d.parent && ts.isClassLike(d.parent) && !(ts.getCombinedModifierFlags(d) & ts.ModifierFlags.Abstract) &&
    (ts.isMethodDeclaration(d) || ts.isPropertyDeclaration(d) || ts.isGetAccessorDeclaration(d))
      ? readerOf(d)
      : undefined;
  const receiverType = (ref: Ref): ts.Type =>
    ts.isBindingElement(ref.node) ? checker.getTypeAtLocation(ref.node.parent) : checker.getTypeAtLocation(ref.node.expression);
  interface Resolved {
    /** The class members it names. */
    readers: string[];
    /** It names an interface, type-literal or abstract member: the receiver type, to fit passing readers into. */
    open?: ts.Type;
    /** The receiver is typed `any`. */
    untyped: boolean;
  }
  const cache = new Map<Ref, Resolved>();
  const resolve = (ref: Ref): Resolved => {
    const hit = cache.get(ref);
    if (hit) return hit;
    const out: Resolved = { readers: [], untyped: false };
    let sym: ts.Symbol | undefined;
    if (ts.isPropertyAccessExpression(ref.node)) sym = checker.getSymbolAtLocation(ref.node.name);
    if (!sym && ref.name !== undefined) {
      const t = receiverType(ref);
      sym = checker.getPropertyOfType(checker.getApparentType(t), ref.name);
      if (!sym && isAny(t)) out.untyped = true;
    }
    if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
    for (const d of sym?.declarations ?? []) {
      const r = declReader(d);
      if (r) out.readers.push(r);
      else if (ts.isMethodSignature(d) || ts.isPropertySignature(d) || (d.parent && ts.isClassLike(d.parent))) {
        out.open = receiverType(ref);
      }
    }
    cache.set(ref, out);
    return out;
  };
  const canAssign = (checker as { isTypeAssignableTo?: (a: ts.Type, b: ts.Type) => boolean }).isTypeAssignableTo;
  /** The passing readers a reference names: `?` for one that fails closed. */
  const calleesOf = (ref: Ref): string[] => {
    if (ref.name === undefined) {
      // x[key] with a key the checker cannot name, on a value whose type holds a passing reader.
      if (!ts.isElementAccessExpression(ref.node)) return [];
      const t = checker.getApparentType(receiverType(ref));
      return t.getProperties().some((p) => (p.declarations ?? []).some((d) => through.has(declReader(d) ?? ''))) ? ['?'] : [];
    }
    const res = resolve(ref);
    const out = res.readers.filter((r) => through.has(r));
    if (res.open) {
      for (const [reader, cls] of throughClass) {
        if (methodName(reader) !== ref.name) continue;
        const sym = cls.name ? checker.getSymbolAtLocation(cls.name) : undefined;
        const inst = sym ? checker.getDeclaredTypeOfSymbol(sym) : undefined;
        if (!inst || !canAssign) out.push('?');
        else if (canAssign.call(checker, inst, res.open)) out.push(reader);
      }
    }
    if (res.untyped && [...through.keys()].some((r) => methodName(r) === ref.name)) out.push('?');
    return [...new Set(out)];
  };
  const modelsOf = (callee: string): string[] => (callee === '?' ? [ANY_MODEL] : [...(through.get(callee) ?? [])]);

  const passing = refs.filter((ref) => passes(ref.reader, ref.member));
  for (let grew = true; grew; ) {
    grew = false;
    for (const ref of passing) {
      for (const callee of calleesOf(ref)) {
        if (callee !== ref.reader && grow(ref.reader, ref.member, modelsOf(callee))) grew = true;
      }
    }
  }
  const seen = new Set<string>();
  for (const ref of refs) {
    for (const callee of calleesOf(ref)) {
      if (callee === ref.reader) continue;
      const line = ref.sf.getLineAndCharacterOfPosition(ref.node.getStart(ref.sf)).line + 1;
      const name = callee === '?' ? `?.${ref.name ?? '[key]'}` : callee;
      for (const model of modelsOf(callee)) {
        const key = `${ref.file}:${line}:${ref.reader}:${model}:${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        sites.push({ file: ref.file, line, reader: ref.reader, model, via: 'caller', callee: name });
      }
    }
  }
  return sites;
}
