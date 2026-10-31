/**
 * Test-only helper for member-content-access.spec.ts (KT-2 in KNOWN_TRAPS.md).
 *
 * It reads prisma/schema.prisma and every runtime file under src/ (never a spec, a __tests__ file or a
 * test helper) and lists each place that READS a member-content table:
 *   prisma    a Prisma read call on the model (findMany, findFirst, findUnique, count, groupBy, aggregate and
 *             their OrThrow forms), however the delegate is reached: `x.communityPost`, `x['communityPost']`,
 *             `x[KEY]`, `const { communityPost } = x`, `const { [KEY]: d } = x`, on any receiver (only the ambiguous
 *             `message` delegate still needs a receiver named like a client: prisma, tx, db, ...). A key is named by
 *             the checker in its own scope (a literal, a `const`, an `as const` member), never by its spelling: an
 *             outer `const model = 'user'` does not name an inner `model: string` (LS-1185R3 B1);
 *   sql       a SQL string that reads the table: FROM or JOIN it, a schema-qualified or quoted name, or a FROM
 *             list (`FROM users u, community_messages m`);
 *   relation  a relation field of a member-content model in `include` or `select`, in any object literal that
 *             reads like a Prisma argument (`{ community_messages_sent: true }`), or held in a constant, a spread,
 *             a `?:` / `??` branch or a function's return (the scan follows each to its initializer), or a fluent
 *             relation read (`findUnique(...).community_messages_sent()`); a relation filter (`{ rel: { some |
 *             none | every | is | isNot: ... } }` anywhere, `{ rel: { field: ... } }` in a `where`) and an order by
 *             a relation count (`{ rel: { _count: 'desc' } }`), each an EXISTS or a count over the table, are reads
 *             like an include (LO-1185R3 B1). FR-1185R4 (the class of LS-1185R5 B1 and LS-1185R4 B2): at every read
 *             call on any model, its argument is followed back to where it is made (a constant or a `let` and its
 *             later writes, a key set on it in a loop or a branch, Object.assign, a push, a spread, a helper's
 *             return in any scanned file, a parameter at every call the scan sees) and walked model by model
 *             through the schema (where, AND / OR / NOT, relation filters, select, include, orderBy, `_count`);
 *             each relation into a member-content model is a read of the function that makes the call
 *             (followHeldArguments);
 *   aliased   the delegate kept in a variable, passed along, destructured, or named in a string ('communityWin'
 *             handed to a generic reader);
 *   dynamic   FAIL CLOSED: a read the scan cannot tie to one model (a delegate picked by a runtime key: `x[model]`
 *             on a client or read later, `const { [model]: d } = x` from a client or read later; a table named
 *             through Prisma.raw or a ${} after FROM/JOIN, also schema-qualified with or without quotes (`FROM
 *             public.${...}`, `FROM "public".${...}`); SQL built at runtime for $queryRawUnsafe or handed to
 *             Prisma.raw (LO-1185R3 C2); an include or select whose value or key the scan cannot follow, `{
 *             [relation]: true }` with a runtime key, `_count: true` (every relation of the model)); and (FR-1185R4)
 *             a where, select, include or count argument the follow-back cannot follow (a parameter of a callback
 *             or of a function no scanned code calls, a package's call, a key it cannot name, `_count: true` held
 *             anywhere, an object handed to a package's function that may add keys) on a model that can reach
 *             members' content (modelsReachingMemberContent; on any other model it is quiet). The site's model
 *             is ANY_MODEL ('*'); the registry must list the reader with '*' and say what it reads;
 *   caller    a reference to a reader that leaves the rules to its caller, from another function: every repository
 *             reader (a *Repository class method that reads a model, passesRowsOn), every registry row that lists
 *             `callers` (ScanOptions.passThrough: MessagingService.listThread), and, to a fixed point, every
 *             repository method that wraps one (same class or not). One TypeScript program over src/ (with the
 *             ES2021 lib: a Map, a Promise or an array callback resolves) resolves the reference with the checker:
 *             import aliases, `this.x` and getter types, untyped locals, `const { x } = this`, destructured methods,
 *             `x['name']` and `x[NAME]`, `.call` / `.apply` / `.bind`, subclasses, and an interface, type-literal or
 *             abstract member (each passing reader whose class fits the receiver type). FAIL CLOSED (callee
 *             `?.name`, model '*'): a passing reader's name on a value typed `any`, and a key the checker cannot
 *             name (`x[key]`, `const { [key]: f } = x`) on a value whose type can hold a passing reader: a class
 *             member that is one, or an interface, type-literal, abstract or class member one fits (LS-1185R3 B2).
 *             The caller is a read site unless the reader's row lists it in `callers` (LO-1185 B3, LS-1185R2 B1,
 *             LO-1185R2 B2 and C1).
 * Writes (create, update, upsert, delete) are not reads and are not listed. A write that returns rows is a
 * write here; the registry still lists the function when it also reads.
 *
 * Limits (each shown by a test in member-content-access.spec.ts, 'limit L1' to 'limit L13'; L10 is closed):
 *   L1 the program loads no node_modules (noResolve: one program over src/ in about 10 s), so a value whose type
 *      comes from a package (`moduleRef.get(Repo)`) is unresolved, not `any`; a reader's name called on it is not
 *      seen (failing closed there flags Supabase storage `list`, a false read on every package call named like a
 *      reader). Built-in types resolve (the ES2021 lib is loaded, LO-1185R3 C1);
 *   L2 a reader named only at runtime (`Reflect.get(repo, name)`, a generic invoker taking the method name as a
 *      string) is not seen;
 *   L3 a method outside a *Repository class that hands a reader's rows on is a pass-through only when its row
 *      declares `callers` (structurally every service method returns rows, so the scan cannot tell a method that
 *      applied the rules from one that did not);
 *   L4 a reader's rows kept in a field or a closure and read by another method are not traced (only the reference
 *      to the reader is a site);
 *   L5 SQL assembled from string concatenation outside an Unsafe or Prisma.raw call is matched piece by piece;
 *   L6 the registry has one row per function and model, so a second read of a model inside a function already
 *      registered for it is covered by that row (LO-1185 N4);
 *   L7 a write that returns rows (create, update, upsert, delete) is a write, not a read (LO-1185 N3);
 *   L8 the legacy `message` delegate (Message) kept in a variable or destructured from a receiver not named like a
 *      client is not seen (`x.message` is every error's message); its read calls on any receiver are;
 *   L9 a key the checker cannot name on a value typed `any` (`anyValue[key](...)`) is not a caller site (every
 *      dynamic key on an untyped value would be); on a client, or with a read call after it, it fails closed;
 *   L10 CLOSED in FR-1185R4: a to-one relation filter written without `is` and held outside a `where` (a
 *      constant passed as the where later) is a read of the call that uses it (followHeldArguments);
 *   L11 a key set on a held argument through a second name for it (`const alias = where; alias.rel = ...`) is not
 *      seen (keys set on the variable itself, in a loop or a branch, and in a scanned helper it is handed to are);
 *   L12 a parameter is followed to the calls of its function that the scan sees; a call through a reference to
 *      the function handed elsewhere (`run(list)`) is not (a callback's own parameter fails closed);
 *   L13 a read call on a delegate the scan cannot name (a parameter or a value typed any: `delegate.count(...)`)
 *      is not walked (a member-content delegate itself is still an `aliased` or `prisma` site where it is named).
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

/**
 * Keys that make an object literal read like a Prisma relation argument: an include or select of the relation
 * (`{ replies: { where, select } }`), a relation filter (`{ community_messages_sent: { some: {...} } }`, also none,
 * every, is, isNot) or an order by its count (`{ community_posts_authored: { _count: 'desc' } }`). Postgres runs an
 * EXISTS or a count over the relation's table for each, so each is a read like an include (LO-1185R3 B1).
 */
const RELATION_ARG_KEYS = new Set(['select', 'include', 'where', 'orderBy', 'take', 'skip', 'cursor', 'distinct',
  'some', 'none', 'every', 'is', 'isNot', '_count']);

/** The operators of a scalar filter (`{ contains: q, mode: 'insensitive' }`): a value of only these is no relation filter. */
const SCALAR_FILTER_KEYS = new Set(['equals', 'in', 'notIn', 'lt', 'lte', 'gt', 'gte', 'not', 'contains', 'startsWith',
  'endsWith', 'mode', 'search', 'has', 'hasEvery', 'hasSome', 'isEmpty', 'path', 'string_contains', 'array_contains']);

/** Keys of a Prisma argument that hold no filter: a relation key under one of these is not in a `where`. */
const NOT_A_FILTER_KEYS = new Set(['data', 'create', 'update', 'upsert', 'connect', 'connectOrCreate', 'set',
  'select', 'include', 'orderBy', 'cursor', 'by', 'distinct']);

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

/** One schema model: its client delegate and its relation fields (field -> the model it points at). */
export interface SchemaModel {
  delegate: string;
  relations: Map<string, string>;
}

/** Every model of the schema with its relation fields (FR-1185R4: a held argument is walked model by model). */
export function schemaModels(schemaPath = join(REPO_ROOT, 'prisma', 'schema.prisma')): Map<string, SchemaModel> {
  const schema = readFileSync(schemaPath, 'utf8');
  const blocks = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)];
  const names = new Set(blocks.map((b) => b[1]));
  const out = new Map<string, SchemaModel>();
  for (const [, name, body] of blocks) {
    const relations = new Map<string, string>();
    for (const m of body.matchAll(/^[ \t]+(\w+)[ \t]+(\w+)(\[\]|\?)?([ \t]|$)/gm)) if (names.has(m[2])) relations.set(m[1], m[2]);
    out.set(name, { delegate: name[0].toLowerCase() + name.slice(1), relations });
  }
  return out;
}

/**
 * The models that can reach members' content: a member-content model, or one with a relation to a model that
 * can (a where, select, include or count on it can name a member-content relation at some depth).
 */
export function modelsReachingMemberContent(models = schemaModels()): Set<string> {
  const reach = new Set(Object.keys(MEMBER_CONTENT_MODELS).filter((m) => models.has(m)));
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, m] of models) {
      if (!reach.has(name) && [...m.relations.values()].some((t) => reach.has(t))) {
        reach.add(name);
        grew = true;
      }
    }
  }
  return reach;
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
  // LO-1185R3 C1: the bundled ES2021 lib, so a reader behind a built-in type (a Map, a Promise, an array callback)
  // resolves; it adds well under a second to the program over src/.
  lib: ['lib.es2021.d.ts'],
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
    // LS-1185R3 B1: a key is named through the checker in its own scope (literalKey), never by its spelling, so an
    // outer `const model = 'user'` does not name an inner parameter `model: string` (that read fails closed).
    const keyOf = literalKey;
    /** A local bound by `name` and later read like a delegate (`name.findMany(...)`) in its function. */
    const readLater = (name: ts.BindingName): boolean => {
      if (!ts.isIdentifier(name)) return false;
      const sym = checker.getSymbolAtLocation(name);
      const scope = ts.findAncestor(name.parent, (n) => ts.isFunctionLike(n) || ts.isSourceFile(n));
      if (!sym || !scope) return false;
      let found = false;
      const look = (n: ts.Node): void => {
        if (found) return;
        if (ts.isPropertyAccessExpression(n) && READ_METHODS.has(n.name.text)) {
          const x = unwrap(n.expression);
          if (ts.isIdentifier(x) && checker.getSymbolAtLocation(x) === sym) found = true;
        }
        ts.forEachChild(n, look);
      };
      look(scope);
      return found;
    };
    /** An identifier of `sym` written after its initializer: reassigned, a key set on it, Object.assign into it. */
    const changedLater = (sym: ts.Symbol, d: ts.VariableDeclaration): boolean => {
      const scope = ts.findAncestor(d.parent, (n) => ts.isBlock(n) || ts.isSourceFile(n)) ?? d.getSourceFile();
      let changed = false;
      const look = (n: ts.Node): void => {
        if (changed) return;
        if (ts.isIdentifier(n) && n !== d.name && n.text === sym.name && checker.getSymbolAtLocation(n) === sym) {
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
    /** The property sits in a Prisma `where`: directly, or under AND / OR / NOT, some / every / ..., or a relation. */
    const inWhere = (prop: ts.ObjectLiteralElementLike): boolean => {
      let n: ts.Node = prop.parent;
      for (let depth = 0; depth < 16; depth++) {
        let up: ts.Node | undefined = n.parent;
        while (up && (ts.isParenthesizedExpression(up) || ts.isAsExpression(up) || ts.isSatisfiesExpression(up) ||
          ts.isArrayLiteralExpression(up))) up = up.parent;
        if (!up || !ts.isPropertyAssignment(up) || !ts.isObjectLiteralExpression(up.parent)) return false;
        const k = nameOf(up.name) ?? '';
        if (k === 'where') return true;
        if (NOT_A_FILTER_KEYS.has(k)) return false;
        n = up.parent;
      }
      return false;
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
          const held = ts.isVariableDeclaration(parent) && parent.initializer === node && readLater(parent.name);
          if (readCall || held || isClient(unwrap(node.expression).getText(sf))) add(node, ANY_MODEL, 'dynamic');
        }
      }
      // const { communityPost } = x;  const { communityMessage: rows } = x;  const { [model]: d } = x (LS-1185R3 B1)
      if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        const prop = node.propertyName ?? node.name;
        const computed = ts.isComputedPropertyName(prop);
        const key = computed ? keyOf(prop.expression) : nameOf(prop);
        const decl = node.parent.parent;
        const from = ts.isVariableDeclaration(decl) && decl.initializer ? unwrap(decl.initializer).getText(sf) : '';
        if (key && byDelegate.has(key)) {
          const model = byDelegate.get(key) as string;
          if (model !== 'Message' || looksLikeClient(from)) add(node, model, 'aliased');
        } else if (computed && key === undefined && !isStaticKey(prop.expression) && (isClient(from) || readLater(node.name))) {
          // A delegate picked by a runtime key from a client, or read like one later: the model cannot be named.
          add(node, ANY_MODEL, 'dynamic');
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
      // `_count: true` (or a value the scan cannot follow) in an include or select counts every relation of the
      // model, member-content ones included, and names none (LO-1185R3 B1): fails closed. `_count: { select: {...} }`
      // names its relations, each reported below.
      if (ts.isPropertyAssignment(node) && nameOf(node.name) === '_count') {
        const holder = node.parent?.parent;
        const v = unwrap(node.initializer);
        if (holder && ts.isPropertyAssignment(holder) && ['include', 'select'].includes(nameOf(holder.name) ?? '') &&
          v.kind !== ts.SyntaxKind.FalseKeyword && !ts.isObjectLiteralExpression(v)) {
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
            (ts.isObjectLiteralExpression(v) && v.properties.some((p) => RELATION_ARG_KEYS.has(nameOf(p.name) ?? ''))) ||
            // A to-one relation filter written without `is` (`where: { message: { cohort_id } }`): a relation key
            // inside a `where` whose value is not a plain value or a scalar filter (a scalar of the same name takes
            // a string, null or `{ contains, ... }`).
            (inWhere(node) && !(checker.getTypeAtLocation(v).flags & PLAIN) && !(ts.isObjectLiteralExpression(v) &&
              v.properties.length > 0 && v.properties.every((p) => SCALAR_FILTER_KEYS.has(nameOf(p.name) ?? ''))));
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
      // SQL built at runtime for an Unsafe call, or handed to Prisma.raw (LO-1185R3 C2: `$queryRaw(Prisma.raw(sql))`)
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        (/^\$(query|execute)RawUnsafe$/.test(node.expression.name.text) || /(^|\.)Prisma\.raw$/.test(node.expression.getText(sf))) &&
        node.arguments.length > 0) {
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

  followHeldArguments(parsed, checker, sites, siteMembers, looksLikeClient);

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
  /** The passing readers named `name` whose class fits the receiver type `t` (`?` when the checker cannot tell). */
  const fitting = (t: ts.Type, name: string): string[] => {
    const out: string[] = [];
    for (const [reader, cls] of throughClass) {
      if (methodName(reader) !== name) continue;
      const sym = cls.name ? checker.getSymbolAtLocation(cls.name) : undefined;
      const inst = sym ? checker.getDeclaredTypeOfSymbol(sym) : undefined;
      if (!inst || !canAssign) out.push('?');
      else if (canAssign.call(checker, inst, t)) out.push(reader);
    }
    return out;
  };
  /** The passing readers a reference names: `?` for one that fails closed. */
  let names = new Set<string>();
  const calleesOf = (ref: Ref): string[] => {
    // Only a reference by a passing reader's name, or by a key the checker cannot name, can call one (and the
    // checker is asked about nothing else: one program over src/ stays fast).
    if (ref.name !== undefined && !names.has(ref.name)) return [];
    if (ref.name === undefined) {
      // FR-1185R3 class 1 (LS-1185R3 B2): `x[key]` or `const { [key]: f } = x` with a key the checker cannot name,
      // on a value whose type can hold a passing reader, fails closed: a member that is one (a class member), or a
      // member of that name that one fits (an interface, type-literal, abstract or class member; the same rule as a
      // named reference below).
      // LS-1185R4 B1: `this.repo?.[key]` on a `Repo | undefined` or `Repo | null`: the members of the value itself
      // (optional chaining changes whether it runs, not whose rows it reads).
      const t = checker.getNonNullableType(receiverType(ref));
      const holds = checker.getApparentType(t).getProperties().some((p) =>
        (p.declarations ?? []).some((d) => through.has(declReader(d) ?? '')) || (names.has(p.name) && fitting(t, p.name).length > 0));
      return holds ? ['?'] : [];
    }
    const res = resolve(ref);
    const out = res.readers.filter((r) => through.has(r));
    if (res.open) out.push(...fitting(res.open, ref.name));
    if (res.untyped && [...through.keys()].some((r) => methodName(r) === ref.name)) out.push('?');
    return [...new Set(out)];
  };
  const modelsOf = (callee: string): string[] => (callee === '?' ? [ANY_MODEL] : [...(through.get(callee) ?? [])]);

  const passing = refs.filter((ref) => passes(ref.reader, ref.member));
  for (let grew = true; grew; ) {
    grew = false;
    names = new Set([...through.keys()].map(methodName));
    for (const ref of passing) {
      for (const callee of calleesOf(ref)) {
        if (callee !== ref.reader && grow(ref.reader, ref.member, modelsOf(callee))) grew = true;
      }
    }
  }
  names = new Set([...through.keys()].map(methodName));
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

/**
 * FR-1185R4 (owner #189-D3 op 1; LS-1185R5 B1, LS-1185R4 B2): at every Prisma read call on any model, the scan
 * follows the argument back to where it is made and walks it model by model, through the schema's relations:
 * a where (AND / OR / NOT, a relation filter with some / none / every / is / isNot or a to-one filter without
 * them), a select or an include (a relation, its own select / include / where / orderBy, `_count`), an orderBy
 * and a count argument. A value is followed through a constant or a `let` (its initializer and every later
 * assignment), a key set on it (`where.x = ...`, `where[KEY] = ...`, in a loop or a branch), Object.assign into it,
 * an array push, a spread, `?:` / `??` / `||` / `&&`, an element of an object or array, `.map` / `.filter` /
 * `.concat`, the return of a function or method (in any scanned file), a destructured or plain parameter (every
 * call of its function in the scanned files), and an import. A relation into a member-content model is a
 * `relation` read of the call's reader. FAIL CLOSED (a `dynamic` read, model '*'): a value it cannot follow (a
 * parameter of a callback or of a function no scanned code calls, a call it cannot see into, a key it cannot
 * name, `_count: true` or a count it cannot follow) where the model it applies to can reach members' content
 * (modelsReachingMemberContent); on any other model it is quiet.
 */
function followHeldArguments(
  parsed: Parsed[],
  checker: ts.TypeChecker,
  sites: ReadSite[],
  siteMembers: Array<ts.ClassElement | undefined>,
  looksLikeClient: (text: string) => boolean,
): void {
  const models = schemaModels();
  const reach = modelsReachingMemberContent(models);
  const byDelegate = new Map([...models].map(([name, m]) => [m.delegate, name]));
  const isMember = (model: string) => Object.prototype.hasOwnProperty.call(MEMBER_CONTENT_MODELS, model);

  type Prop = { key?: string; value?: ts.Expression };
  /** What a value can be: objects (each a list of keys and values), and whether a part of it cannot be followed. */
  interface Shape {
    objs: Prop[][];
    unknown: boolean;
    /** A value that is no object and not false: `true`, a boolean, a string (an include or `_count` of everything). */
    truthy: boolean;
  }
  const EMPTY = (): Shape => ({ objs: [], unknown: false, truthy: false });
  const UNKNOWN = (): Shape => ({ objs: [], unknown: true, truthy: false });
  const join = (a: Shape, b: Shape): Shape => ({ objs: [...a.objs, ...b.objs], unknown: a.unknown || b.unknown, truthy: a.truthy || b.truthy });
  const keyOf = (e: ts.Expression): string | undefined => {
    const k = unwrap(e);
    if (ts.isStringLiteral(k) || ts.isNoSubstitutionTemplateLiteral(k)) return k.text;
    const t = checker.getTypeAtLocation(k);
    return t.isStringLiteral() ? t.value : undefined;
  };
  const propName = (n: ts.PropertyName): string | undefined =>
    ts.isComputedPropertyName(n) ? keyOf(n.expression) : nameOf(n) ?? (ts.isNumericLiteral(n) ? n.text : undefined);
  const symbolOf = (n: ts.Node): ts.Symbol | undefined => {
    let s = n.parent && ts.isShorthandPropertyAssignment(n.parent) && n.parent.name === n
      ? checker.getShorthandAssignmentValueSymbol(n.parent)
      : checker.getSymbolAtLocation(n);
    if (s && s.flags & ts.SymbolFlags.Alias) s = checker.getAliasedSymbol(s);
    return s;
  };

  // Calls of each function or method in the scanned files (for a parameter), built once on first use.
  let calls: Map<ts.Node, ts.CallLikeExpression[]> | undefined;
  const fnOf = (d: ts.Node | undefined): ts.Node | undefined => {
    if (d && ts.isVariableDeclaration(d) && d.initializer) return unwrap(d.initializer);
    if (d && ts.isPropertyAssignment(d)) return unwrap(d.initializer);
    if (d && ts.isPropertyDeclaration(d) && d.initializer) return unwrap(d.initializer);
    return d;
  };
  const callsOf = (fn: ts.Node): ts.CallLikeExpression[] => {
    if (!calls) {
      calls = new Map();
      const index = calls;
      for (const { sf } of parsed) {
        const look = (n: ts.Node): void => {
          if ((ts.isCallExpression(n) || ts.isNewExpression(n)) && n.arguments && n.arguments.length > 0) {
            let callee = unwrap(n.expression);
            if (ts.isPropertyAccessExpression(callee) && ['call', 'apply', 'bind'].includes(callee.name.text)) callee = unwrap(callee.expression);
            const name = ts.isPropertyAccessExpression(callee) ? callee.name : ts.isElementAccessExpression(callee) ? callee.argumentExpression : callee;
            const sym = symbolOf(name);
            for (const d of sym?.declarations ?? []) {
              const f = ts.isNewExpression(n) && ts.isClassDeclaration(d)
                ? d.members.find((m) => ts.isConstructorDeclaration(m))
                : fnOf(d);
              if (f) index.set(f, [...(index.get(f) ?? []), n]);
            }
          }
          ts.forEachChild(n, look);
        };
        look(sf);
      }
    }
    return calls.get(fn) ?? [];
  };

  const visiting = new Set<ts.Node>();
  /** The changes made to a variable after its initializer, within its scope: alternatives and keys set on it. */
  const writesTo = (sym: ts.Symbol, scope: ts.Node, depth: number): Shape => {
    let out = EMPTY();
    const look = (n: ts.Node): void => {
      if (ts.isIdentifier(n) && n.text === sym.name && symbolOf(n) === sym) {
        const p = n.parent;
        const assigned = (e: ts.Node) => ts.isBinaryExpression(e.parent) && e.parent.left === e &&
          e.parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && e.parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
        if (assigned(n)) out = join(out, shapeOf((p as ts.BinaryExpression).right, depth + 1));
        // where.x = v, where[KEY] = v, where[key] = v (a key it cannot name), also in a loop or a branch
        if ((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === n) {
          const key = ts.isPropertyAccessExpression(p) ? p.name.text : keyOf(p.argumentExpression);
          if (assigned(p)) out = join(out, { objs: [[{ key, value: (p.parent as ts.BinaryExpression).right }]], unknown: false, truthy: false });
          // where.AND.push(x), where.x.y = v: a change below a key of it
          const pp = p.parent;
          if (ts.isPropertyAccessExpression(pp) && pp.expression === p && ts.isCallExpression(pp.parent) && pp.parent.expression === pp &&
            ['push', 'unshift'].includes(pp.name.text)) {
            for (const a of pp.parent.arguments) out = join(out, { objs: [[{ key, value: ts.isSpreadElement(a) ? a.expression : a }]], unknown: false, truthy: false });
          } else if ((ts.isPropertyAccessExpression(pp) || ts.isElementAccessExpression(pp)) && pp.expression === p && assigned(pp)) {
            out = { ...out, unknown: true };
          }
          // arr.push(x): another element
          if (ts.isPropertyAccessExpression(p) && ['push', 'unshift'].includes(p.name.text) && ts.isCallExpression(p.parent) && p.parent.expression === p) {
            for (const a of p.parent.arguments) out = join(out, shapeOf(ts.isSpreadElement(a) ? a.expression : a, depth + 1));
          }
        }
        // Object.assign(where, other)
        if (ts.isCallExpression(p) && p.arguments[0] === n && /(^|\.)assign$/.test(p.expression.getText())) {
          for (const a of p.arguments.slice(1)) out = join(out, shapeOf(a, depth + 1));
        } else if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.arguments?.includes(n as ts.Expression)) {
          // handed to a function that may add keys to it (`addFilters(where)`): what that function writes to its
          // parameter; a function the scan cannot see into (a package's) fails closed, one without a body (a
          // built-in such as JSON.stringify) writes nothing
          out = join(out, handedTo(p, p.arguments.indexOf(n as ts.Expression), depth));
        }
      }
      ts.forEachChild(n, look);
    };
    look(scope);
    return out;
  };
  /** What a called function writes to the parameter at `index` (keys set on it there). */
  const handedTo = (call: ts.CallExpression | ts.NewExpression, index: number, depth: number): Shape => {
    const callee = unwrap(call.expression);
    if (ts.isPropertyAccessExpression(callee) && READ_METHODS.has(callee.name.text)) return EMPTY(); // the read itself
    if (ts.isPropertyAccessExpression(callee) && WRITE_METHODS.has(callee.name.text)) return EMPTY();
    const sym = symbolOf(ts.isPropertyAccessExpression(callee) ? callee.name : ts.isElementAccessExpression(callee) ? callee.argumentExpression : callee);
    const decls = sym?.declarations ?? [];
    if (decls.length === 0) return UNKNOWN();
    let out = EMPTY();
    for (const d of decls) {
      const fn = fnOf(d);
      if (!fn || !ts.isFunctionLike(fn)) return UNKNOWN();
      if (!('body' in fn) || !fn.body) continue; // a declaration only (a built-in): writes nothing
      const param = fn.parameters[index];
      if (!param) continue;
      if (!ts.isIdentifier(param.name)) return UNKNOWN();
      const psym = checker.getSymbolAtLocation(param.name);
      if (!psym || visiting.has(param)) continue;
      visiting.add(param);
      try {
        out = join(out, writesTo(psym, fn.body, depth + 1));
      } finally {
        visiting.delete(param);
      }
    }
    return out;
  };
  /** The values a symbol holds: its initializer, later writes, a parameter's arguments, a property's value. */
  const valueOf = (sym: ts.Symbol | undefined, depth: number): Shape => {
    const d = sym?.valueDeclaration ?? sym?.declarations?.[0];
    if (!sym || !d) return UNKNOWN();
    if (visiting.has(d)) {
      cuts++;
      return EMPTY(); // a cycle adds nothing new
    }
    visiting.add(d);
    try {
      if (ts.isVariableDeclaration(d) && ts.isIdentifier(d.name)) {
        const scope = ts.findAncestor(d.parent, (n) => ts.isFunctionLike(n) || ts.isSourceFile(n)) ?? d.getSourceFile();
        const init = d.initializer ? shapeOf(d.initializer, depth + 1) : EMPTY();
        // for (const where of list): an element of the list
        const loop = d.parent.parent;
        const each = !d.initializer && (ts.isForOfStatement(loop) || ts.isForInStatement(loop)) && loop.initializer === d.parent
          ? (ts.isForOfStatement(loop) ? shapeOf(loop.expression, depth + 1) : EMPTY())
          : EMPTY();
        return join(join(init, each), writesTo(sym, scope, depth));
      }
      if (ts.isParameter(d)) return join(argumentsOf(d, depth), writesTo(sym, d.parent, depth));
      if (ts.isBindingElement(d)) return bindingValue(d, depth);
      if ((ts.isPropertyAssignment(d) || ts.isPropertyDeclaration(d)) && d.initializer) return shapeOf(d.initializer, depth + 1);
      if (ts.isShorthandPropertyAssignment(d)) return valueOf(checker.getShorthandAssignmentValueSymbol(d), depth + 1);
      if (ts.isEnumMember(d) || ts.isGetAccessorDeclaration(d) && !d.body) return EMPTY();
      if (ts.isGetAccessorDeclaration(d) && d.body) return returnsOf(d, depth);
      return UNKNOWN();
    } finally {
      visiting.delete(d);
    }
  };
  /** A parameter's values: the matching argument at every call of its function in the scanned files. */
  const argumentsOf = (p: ts.ParameterDeclaration, depth: number): Shape => {
    const fn = p.parent;
    const index = fn.parameters.indexOf(p);
    let out = p.initializer ? shapeOf(p.initializer, depth + 1) : EMPTY();
    if (p.dotDotDotToken) return UNKNOWN();
    // A callback (an argument, `$transaction(async (tx) => ...)`) is called by code the scan does not see.
    const found = callsOf(fn);
    if (found.length === 0) return UNKNOWN();
    for (const c of found) {
      const args = c.arguments ?? ts.factory.createNodeArray();
      if (args.slice(0, index + 1).some((a) => ts.isSpreadElement(a))) return UNKNOWN();
      const a = args[index];
      if (a) out = join(out, shapeOf(a, depth + 1));
    }
    return out;
  };
  /** `const { where } = args`, `({ where }: Args) => ...`: the key of the destructured value. */
  const bindingValue = (b: ts.BindingElement, depth: number): Shape => {
    const pattern = b.parent;
    if (ts.isArrayBindingPattern(pattern)) {
      // const [scope, other] = await Promise.all([...]): any element of the source
      if (b.dotDotDotToken) return UNKNOWN();
      const holder = pattern.parent;
      const index = pattern.elements.indexOf(b);
      if (ts.isVariableDeclaration(holder) && holder.initializer) {
        // the element at its place in an array literal (also awaited, or in Promise.all), else any element
        let src = unwrap(holder.initializer);
        if (ts.isAwaitExpression(src)) src = unwrap(src.expression);
        if (ts.isCallExpression(src) && /^Promise\.(all|allSettled)$/.test(src.expression.getText()) && src.arguments[0]) src = unwrap(src.arguments[0]);
        if (ts.isArrayLiteralExpression(src) && !src.elements.slice(0, index + 1).some((e) => ts.isSpreadElement(e))) {
          const e = src.elements[index];
          return e ? shapeOf(e, depth + 1) : EMPTY();
        }
        return shapeOf(holder.initializer, depth + 1);
      }
      if (ts.isParameter(holder)) return argumentsOf(holder, depth + 1);
      return UNKNOWN();
    }
    if (!ts.isObjectBindingPattern(pattern)) return UNKNOWN();
    const key = b.propertyName ? propName(b.propertyName) : nameOf(b.name);
    if (b.dotDotDotToken || key === undefined) return UNKNOWN();
    const holder = pattern.parent;
    let source: Shape;
    if (ts.isVariableDeclaration(holder) && holder.initializer) source = shapeOf(holder.initializer, depth + 1);
    else if (ts.isParameter(holder)) source = argumentsOf(holder, depth + 1);
    else if (ts.isBindingElement(holder)) source = bindingValue(holder, depth + 1);
    else return UNKNOWN();
    let out = b.initializer ? shapeOf(b.initializer, depth + 1) : EMPTY();
    out = { ...out, unknown: out.unknown || source.unknown };
    for (const obj of source.objs) {
      for (const prop of obj) {
        if (prop.key === undefined) out = { ...out, unknown: true };
        else if (prop.key === key) out = join(out, prop.value ? shapeOf(prop.value, depth + 1) : UNKNOWN());
      }
    }
    return out;
  };
  /** What a function or method returns (every return, or an arrow's expression body). */
  const returnsOf = (fn: ts.Node, depth: number): Shape => {
    if (!(ts.isFunctionLike(fn)) || !('body' in fn) || !fn.body) return UNKNOWN();
    const body = fn.body as ts.Node;
    if (!ts.isBlock(body)) return shapeOf(body as ts.Expression, depth + 1);
    let out = EMPTY();
    const look = (n: ts.Node): void => {
      if (ts.isReturnStatement(n)) out = join(out, n.expression ? shapeOf(n.expression, depth + 1) : EMPTY());
      if (!ts.isFunctionLike(n)) ts.forEachChild(n, look);
    };
    ts.forEachChild(body, look);
    return out;
  };
  // Each value is followed once: a result that a cycle did not cut short is kept for every later read.
  const known = new Map<ts.Node, Shape>();
  let cuts = 0;
  const shapeOf = (expr: ts.Expression, depth: number): Shape => {
    const hit = known.get(expr);
    if (hit) return hit;
    const before = cuts;
    const out = followValue(expr, depth);
    if (cuts === before) known.set(expr, out);
    return out;
  };
  const followValue = (expr: ts.Expression, depth: number): Shape => {
    const v = unwrap(expr);
    if (depth > 24) {
      cuts++;
      return UNKNOWN();
    }
    if (v.kind === ts.SyntaxKind.FalseKeyword || v.kind === ts.SyntaxKind.NullKeyword ||
      (ts.isIdentifier(v) && v.text === 'undefined') || ts.isVoidExpression(v)) return EMPTY();
    if (v.kind === ts.SyntaxKind.TrueKeyword || ts.isStringLiteral(v) || ts.isNumericLiteral(v) ||
      ts.isNoSubstitutionTemplateLiteral(v) || ts.isTemplateExpression(v)) return { ...EMPTY(), truthy: true };
    if (ts.isObjectLiteralExpression(v)) {
      const obj: Prop[] = [];
      let out = EMPTY();
      for (const p of v.properties) {
        if (ts.isSpreadAssignment(p)) {
          const s = shapeOf(p.expression, depth + 1);
          for (const o of s.objs) obj.push(...o);
          out = { ...out, unknown: out.unknown || s.unknown };
        } else if (ts.isPropertyAssignment(p)) obj.push({ key: propName(p.name), value: p.initializer });
        else if (ts.isShorthandPropertyAssignment(p)) obj.push({ key: p.name.text, value: p.name });
        else obj.push({ key: p.name ? propName(p.name) : undefined }); // a method or accessor: a value it does not follow
      }
      return { ...out, objs: [obj] };
    }
    if (ts.isArrayLiteralExpression(v)) {
      let out = EMPTY();
      for (const e of v.elements) out = join(out, shapeOf(ts.isSpreadElement(e) ? e.expression : e, depth + 1));
      return { ...out, truthy: false };
    }
    if (ts.isConditionalExpression(v)) return join(shapeOf(v.whenTrue, depth + 1), shapeOf(v.whenFalse, depth + 1));
    if (ts.isBinaryExpression(v) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.AmpersandAmpersandToken].includes(v.operatorToken.kind)) {
      // `cond && { ... }` is the right side or a falsy left one (no object, no key: nothing to spread or read)
      if (v.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return shapeOf(v.right, depth + 1);
      return join(shapeOf(v.left, depth + 1), shapeOf(v.right, depth + 1));
    }
    if (ts.isBinaryExpression(v) && v.operatorToken.kind === ts.SyntaxKind.CommaToken) return shapeOf(v.right, depth + 1);
    if (ts.isBinaryExpression(v) || ts.isPrefixUnaryExpression(v) || ts.isTypeOfExpression(v)) return { ...EMPTY(), truthy: true };
    if (ts.isIdentifier(v) || ts.isPropertyAccessExpression(v)) {
      const sym = symbolOf(ts.isIdentifier(v) ? v : v.name);
      if (sym) return valueOf(sym, depth + 1);
      // `holder.key` on a value the checker cannot type: the key of what it holds
      if (ts.isPropertyAccessExpression(v)) return pick(shapeOf(v.expression, depth + 1), v.name.text, depth);
      return plainOr(v);
    }
    if (ts.isElementAccessExpression(v)) {
      const key = keyOf(v.argumentExpression);
      const sym = key !== undefined ? checker.getSymbolAtLocation(v) : undefined;
      if (sym) return valueOf(sym, depth + 1);
      // WHERES[kind], LIST[i]: any element of what it holds
      return pick(shapeOf(v.expression, depth + 1), key, depth);
    }
    if (ts.isCallExpression(v)) {
      const callee = unwrap(v.expression);
      if (ts.isPropertyAccessExpression(callee)) {
        const m = callee.name.text;
        // Object.assign({}, a, b) and structuredClone(x) keep their parts
        if (m === 'assign' && /^Object$/.test(callee.expression.getText())) {
          let out = EMPTY();
          for (const a of v.arguments) out = join(out, shapeOf(a, depth + 1));
          return out;
        }
        // list.map((x) => ({ ... })), list.flatMap(...): what the callback returns; filter / slice / concat keep it
        if (['map', 'flatMap'].includes(m) && v.arguments[0] && (ts.isArrowFunction(unwrap(v.arguments[0])) ||
          ts.isFunctionExpression(unwrap(v.arguments[0])))) return returnsOf(unwrap(v.arguments[0]), depth);
        if (['filter', 'slice', 'concat', 'reverse', 'sort'].includes(m)) {
          let out = shapeOf(callee.expression, depth + 1);
          if (m === 'concat') for (const a of v.arguments) out = join(out, shapeOf(a, depth + 1));
          return out;
        }
      }
      // Promise.all([a, b]), Promise.resolve(x): what each part holds (an array binding takes any of them)
      if (ts.isPropertyAccessExpression(callee) && callee.expression.getText() === 'Promise' &&
        ['all', 'allSettled', 'resolve'].includes(callee.name.text) && v.arguments[0]) return shapeOf(v.arguments[0], depth + 1);
      if (ts.isIdentifier(callee) && callee.text === 'structuredClone' && v.arguments[0]) return shapeOf(v.arguments[0], depth + 1);
      const sym = symbolOf(ts.isPropertyAccessExpression(callee) ? callee.name : callee);
      const fn = fnOf(sym?.valueDeclaration);
      if (fn && ts.isFunctionLike(fn) && 'body' in fn && fn.body) {
        if (visiting.has(fn)) {
          cuts++;
          return EMPTY();
        }
        visiting.add(fn);
        try {
          return returnsOf(fn, depth);
        } finally {
          visiting.delete(fn);
        }
      }
      return plainOr(v);
    }
    if (ts.isAwaitExpression(v)) return shapeOf(v.expression, depth + 1);
    return plainOr(v);
  };
  /** A value the scan does not follow: quiet when its type is plain (true, a string, a number, nothing). */
  const plainOr = (v: ts.Expression): Shape => {
    const t = checker.getTypeAtLocation(v);
    if (t.flags & PLAIN) return { ...EMPTY(), truthy: !(t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) };
    if (t.isUnion() && t.types.every((x) => x.flags & PLAIN)) return { ...EMPTY(), truthy: true };
    // a list of plain values (`string[]`): no key, no relation
    const element = checker.isArrayType(t) ? checker.getTypeArguments(t as ts.TypeReference)[0] : undefined;
    if (element && (element.flags & PLAIN || (element.isUnion() && element.types.every((x) => x.flags & PLAIN)))) return EMPTY();
    return UNKNOWN();
  };
  /** The value under `key` (any key when undefined) of what a shape holds. */
  const pick = (s: Shape, key: string | undefined, depth: number): Shape => {
    let out: Shape = { ...EMPTY(), unknown: s.unknown };
    for (const obj of s.objs) {
      for (const prop of obj) {
        if (key === undefined || prop.key === undefined || prop.key === key) out = join(out, prop.value ? shapeOf(prop.value, depth + 1) : UNKNOWN());
      }
    }
    return out;
  };

  for (const { file, sf } of parsed) {
    const found = new Set<string>();
    const add = (call: ts.Node, model: string, via: ReadSite['via']) => {
      const line = sf.getLineAndCharacterOfPosition(call.getStart(sf)).line + 1;
      const reader = readerOf(call);
      const key = `${line}:${reader}:${model}:${via}`;
      if (found.has(key)) return;
      found.add(key);
      sites.push({ file, line, reader, model, via });
      siteMembers.push(memberOf(call));
    };
    const walkers = (call: ts.Node) => {
      const seen = new Set<string>();
      const once = (model: string, node: ts.Node) => {
        const k = `${model}:${node.pos}:${node.end}:${node.getSourceFile().fileName}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      };
      const dynamic = (model: string) => {
        if (reach.has(model)) add(call, ANY_MODEL, 'dynamic');
      };
      const relation = (target: string) => {
        if (isMember(target)) add(call, target, 'relation');
      };
      const each = (model: string, s: Shape, walk: (model: string, key: string, value: ts.Expression | undefined) => void) => {
        if (s.unknown) dynamic(model);
        for (const obj of s.objs) {
          for (const p of obj) {
            if (p.key === undefined) dynamic(model);
            else walk(model, p.key, p.value);
          }
        }
      };
      const valueShape = (value: ts.Expression | undefined): Shape => (value ? shapeOf(value, 0) : UNKNOWN());
      /** A where on `model`. */
      const where = (model: string, value: ts.Expression | undefined): void => {
        if (value && !once(`w:${model}`, value)) return;
        each(model, valueShape(value), whereKey);
      };
      const whereKey = (model: string, key: string, value: ts.Expression | undefined): void => {
        if (key === 'AND' || key === 'OR' || key === 'NOT') return where(model, value);
        const target = models.get(model)?.relations.get(key);
        if (!target) return; // a scalar field: its value names no relation
        relation(target);
        // { some | none | every | is | isNot: where } or a to-one where without them
        each(target, valueShape(value), (t, k, v) => {
          if (['some', 'none', 'every', 'is', 'isNot'].includes(k)) where(t, v);
          else whereKey(t, k, v);
        });
      };
      /** A select or include on `model`. */
      const select = (model: string, value: ts.Expression | undefined): void => {
        if (value && !once(`s:${model}`, value)) return;
        each(model, valueShape(value), (m, key, v) => {
          if (key === '_count') return count(m, v);
          const target = models.get(m)?.relations.get(key);
          if (!target) return;
          const s = valueShape(v);
          if (s.objs.length === 0 && !s.unknown && !s.truthy) return; // false or nothing
          relation(target);
          if (s.unknown) dynamic(target);
          for (const obj of s.objs) args(target, obj);
        });
      };
      /** `_count` in a select or include: true counts every relation; `{ select: { rel: true | { where } } }`. */
      const count = (model: string, value: ts.Expression | undefined): void => {
        const s = valueShape(value);
        if (s.truthy) dynamic(model);
        if (s.unknown) dynamic(model);
        for (const obj of s.objs) {
          for (const p of obj) {
            if (p.key === undefined) dynamic(model);
            else if (p.key === 'select') {
              each(model, valueShape(p.value), (m, rel, v) => {
                const target = models.get(m)?.relations.get(rel);
                if (!target) return;
                const r = valueShape(v);
                if (r.objs.length === 0 && !r.unknown && !r.truthy) return;
                relation(target);
                if (r.unknown) dynamic(target);
                for (const o of r.objs) for (const q of o) if (q.key === 'where') where(target, q.value);
              });
            }
          }
        }
      };
      /** An orderBy on `model`: a relation key orders by the related rows (a join, or a count of them). */
      const orderBy = (model: string, value: ts.Expression | undefined): void => {
        if (value && !once(`o:${model}`, value)) return;
        each(model, valueShape(value), (m, key, v) => {
          const target = models.get(m)?.relations.get(key);
          if (!target) return;
          relation(target);
          orderBy(target, v);
        });
      };
      /** The keys of a Prisma argument object (or a relation's include value) on `model`. */
      const args = (model: string, obj: Prop[]): void => {
        for (const p of obj) {
          if (p.key === undefined) dynamic(model);
          else if (p.key === 'where' || p.key === 'having') where(model, p.value);
          else if (p.key === 'select' || p.key === 'include') select(model, p.value);
          else if (p.key === 'orderBy') orderBy(model, p.value);
          else if (p.key === '_count') {
            // a count's own `_count` counts this model's rows (and its `select` names fields), not relations
          }
        }
      };
      return { top: (model: string, arg: ts.Expression | undefined) => {
        if (!arg) return;
        const s = shapeOf(arg, 0);
        if (s.unknown) dynamic(model);
        for (const obj of s.objs) args(model, obj);
      } };
    };
    /** The model of a delegate expression: `x.user`, `x['user']`, or a constant that holds one. */
    const delegateModel = (e: ts.Expression, depth = 0): string | undefined => {
      const d = unwrap(e);
      if (ts.isPropertyAccessExpression(d) && byDelegate.has(d.name.text)) {
        if (d.name.text === 'message' && !looksLikeClient(unwrap(d.expression).getText(sf))) return undefined;
        return byDelegate.get(d.name.text);
      }
      if (ts.isElementAccessExpression(d)) {
        const k = keyOf(d.argumentExpression);
        return k !== undefined ? byDelegate.get(k) : undefined;
      }
      if (ts.isIdentifier(d) && depth < 4) {
        const decl = symbolOf(d)?.valueDeclaration;
        if (decl && ts.isVariableDeclaration(decl) && decl.initializer && ts.isIdentifier(decl.name)) return delegateModel(decl.initializer, depth + 1);
      }
      return undefined;
    };
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && READ_METHODS.has(node.expression.name.text)) {
        const model = delegateModel(node.expression.expression);
        if (model) walkers(node).top(model, node.arguments[0]);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
}
