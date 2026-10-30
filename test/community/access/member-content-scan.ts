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
 *             reads like a Prisma argument (`{ community_messages_sent: true }`, also held in a constant), or a
 *             fluent relation read (`findUnique(...).community_messages_sent()`);
 *   aliased   the delegate kept in a variable, passed along, destructured, or named in a string ('communityWin'
 *             handed to a generic reader);
 *   dynamic   FAIL CLOSED: a read the scan cannot tie to one model (a delegate picked by a runtime key, a table
 *             named through Prisma.raw or a ${} after FROM/JOIN, SQL built at runtime for $queryRawUnsafe). The
 *             site's model is ANY_MODEL ('*'); the registry must list the reader with '*' and say what it reads;
 *   caller    a call of a repository reader (a *Repository class method that reads a model) from another class
 *             or function. Many repository readers leave block, ban and departure to their caller, so each
 *             caller is a read site too, unless the repository row lists it in `callers` (B3 of LO-1185).
 * Writes (create, update, upsert, delete) are not reads and are not listed. A write that returns rows is a
 * write here; the registry still lists the function when it also reads.
 *
 * Limits (named, so a reviewer can weigh them): receivers of a `caller` read are resolved by the declared type
 * of `this.x` (constructor parameter or property) or of a typed parameter or `new` variable, not by full type
 * inference; SQL assembled from string concatenation outside an Unsafe call is matched piece by piece.
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

/** A SQL text whose table comes from a ${} right after FROM / JOIN (or a FROM-list comma). */
const SQL_DYNAMIC_TABLE = /\b(from|join)[ \t\n]+(?:[^;()]*?,[ \t\n]*)?$/i;

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

/** The class name a type annotation names (`CommunityMessagesRepository`, `Readonly<X>` is not followed). */
const typeName = (t: ts.TypeNode | undefined): string | undefined =>
  t && ts.isTypeReferenceNode(t) ? t.typeName.getText().split('.').pop() : undefined;

/** The declared class of a receiver: `this.x` (constructor parameter or property), a typed parameter or a `new`. */
function receiverType(recv: ts.Expression): string | undefined {
  const r = unwrap(recv);
  if (ts.isPropertyAccessExpression(r) && r.expression.kind === ts.SyntaxKind.ThisKeyword) {
    const cls = classOf(r);
    if (!cls) return undefined;
    const prop = r.name.text;
    for (const m of cls.members) {
      if (ts.isConstructorDeclaration(m)) {
        for (const p of m.parameters) if (nameOf(p.name) === prop) return typeName(p.type);
      }
      if (ts.isPropertyDeclaration(m) && nameOf(m.name) === prop) {
        if (m.type) return typeName(m.type);
        if (m.initializer && ts.isNewExpression(m.initializer)) return m.initializer.expression.getText();
      }
    }
    return undefined;
  }
  if (ts.isIdentifier(r)) {
    for (let n: ts.Node | undefined = r.parent; n; n = n.parent) {
      if (ts.isFunctionLike(n)) {
        for (const p of n.parameters) if (nameOf(p.name) === r.text && p.type) return typeName(p.type);
      }
      if (ts.isBlock(n) || ts.isSourceFile(n)) {
        for (const st of n.statements) {
          if (!ts.isVariableStatement(st)) continue;
          for (const d of st.declarationList.declarations) {
            if (nameOf(d.name) !== r.text) continue;
            if (d.type) return typeName(d.type);
            if (d.initializer && ts.isNewExpression(unwrap(d.initializer))) {
              return (unwrap(d.initializer) as ts.NewExpression).expression.getText();
            }
          }
        }
      }
    }
  }
  return undefined;
}

interface Parsed {
  abs: string;
  file: string;
  sf: ts.SourceFile;
}

/** Every read of a member-content table in runtime code under src/. */
export function scanMemberContentReads(srcRoot = join(REPO_ROOT, 'src')): ReadSite[] {
  const tables = memberContentTables();
  const relations = memberContentRelations();
  const byDelegate = new Map(Object.entries(tables).map(([model, t]) => [t.delegate, model]));
  const sqlTables = Object.entries(tables).map(([model, t]) => ({ model, re: sqlReadsTable(t.table) }));
  const looksLikeClient = (text: string) => /(^|\.)(prisma|tx|trx|db|client)$/i.test(text) || /prisma/i.test(text);
  // A receiver that is a Prisma client itself (for `client[key]`): prisma, this.prisma, tx, db, ...
  const isClient = (text: string) => /(^|\.)(prisma|prismaService|tx|trx|db|client)$/i.test(text);
  const sites: ReadSite[] = [];
  const parsed: Parsed[] = runtimeFiles(srcRoot).map((abs) => ({
    abs,
    file: relative(REPO_ROOT, abs).split(sep).join('/'),
    sf: ts.createSourceFile(abs, readFileSync(abs, 'utf8'), ts.ScriptTarget.ES2021, true, ts.ScriptKind.TS),
  }));

  for (const { file, sf } of parsed) {
    const add = (node: ts.Node, model: string, via: ReadSite['via'], callee?: string) => {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      sites.push({ file, line, reader: readerOf(node), model, via, ...(callee ? { callee } : {}) });
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
      if (ts.isStringLiteral(k) || ts.isNoSubstitutionTemplateLiteral(k)) return k.text;
      if (ts.isIdentifier(k)) return constants.get(k.text);
      return undefined;
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

  // Repository readers: a *Repository class method that reads a model. Their callers are read sites too.
  const repoReads = new Map<string, Set<string>>();
  for (const s of sites) {
    const [cls, method] = s.reader.split('.');
    if (!method || !/Repository$/.test(cls) || s.via === 'caller') continue;
    const key = `${cls}.${method}`;
    if (!repoReads.has(key)) repoReads.set(key, new Set());
    (repoReads.get(key) as Set<string>).add(s.model);
  }
  for (const { file, sf } of parsed) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const recv = node.expression.expression;
        const cls = recv.kind === ts.SyntaxKind.ThisKeyword ? undefined : receiverType(recv);
        const callee = cls ? `${cls}.${node.expression.name.text}` : undefined;
        const reader = readerOf(node);
        if (callee && repoReads.has(callee) && reader.split('.')[0] !== cls) {
          const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
          for (const model of repoReads.get(callee) as Set<string>) sites.push({ file, line, reader, model, via: 'caller', callee });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return sites;
}
