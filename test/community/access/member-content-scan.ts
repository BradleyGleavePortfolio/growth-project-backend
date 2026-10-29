/**
 * Test-only helper for member-content-access.spec.ts (KT-2 in KNOWN_TRAPS.md).
 *
 * It reads prisma/schema.prisma and every runtime file under src/ (never a spec, a __tests__ file or a
 * test helper) and lists each place that READS a member-content table: a Prisma read call on the
 * model (findMany, findFirst, findUnique, count, groupBy, aggregate and their OrThrow forms) or a raw
 * SQL string that selects FROM or JOINs the table. Writes (create, update, upsert, delete) are not
 * reads and are not listed. A model reached any other way (kept in a variable, passed along) is listed
 * as "aliased", so it cannot slip past the scan.
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

export interface ReadSite {
  /** Repo-relative path with forward slashes, e.g. src/community/messages/community-messages.repository.ts */
  file: string;
  line: number;
  /** Enclosing reader: Class.method, a top-level function or const, or <module>. */
  reader: string;
  model: string;
  via: 'prisma' | 'sql' | 'aliased' | 'relation';
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
  const re = new RegExp(`^\\s+(\\w+)\\s+(${models})(\\[\\]|\\?)?(\\s|$)`, 'gm');
  const out = new Map<string, string>();
  for (const m of readFileSync(schemaPath, 'utf8').matchAll(re)) {
    const prev = out.get(m[1]);
    out.set(m[1], prev && prev !== m[2] ? `${prev}|${m[2]}` : m[2]);
  }
  return out;
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
  if (ts.isIdentifier(n) || ts.isPrivateIdentifier(n) || ts.isStringLiteral(n)) return n.text;
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

/** Every read of a member-content table in runtime code under src/. */
export function scanMemberContentReads(srcRoot = join(REPO_ROOT, 'src')): ReadSite[] {
  const tables = memberContentTables();
  const relations = memberContentRelations();
  const byDelegate = new Map(Object.entries(tables).map(([model, t]) => [t.delegate, model]));
  const sqlTables = Object.entries(tables).map(([model, t]) => ({
    model,
    re: new RegExp(`\\b(from|join)\\s+(public\\.)?"?${t.table}"?(?![A-Za-z0-9_])`, 'i'),
  }));
  const sites: ReadSite[] = [];
  for (const abs of runtimeFiles(srcRoot)) {
    const text = readFileSync(abs, 'utf8');
    const file = relative(REPO_ROOT, abs).split(sep).join('/');
    const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.ES2021, true, ts.ScriptKind.TS);
    const add = (node: ts.Node, model: string, via: ReadSite['via']) => {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      sites.push({ file, line, reader: readerOf(node), model, via });
    };
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && byDelegate.has(node.name.text)) {
        const model = byDelegate.get(node.name.text) as string;
        const parent = node.parent;
        const method = parent && ts.isPropertyAccessExpression(parent) && parent.expression === node ? parent.name.text : undefined;
        // `x.message` is a common field name; only a Prisma-client-looking receiver counts for that one.
        const receiver = node.expression.getText(sf);
        const looksLikeClient = /(^|\.)(prisma|tx|trx|db|client)$/i.test(receiver) || /prisma/i.test(receiver);
        if (method && READ_METHODS.has(method)) add(node, model, 'prisma');
        else if (method && WRITE_METHODS.has(method)) {
          /* a write, not a read */
        } else if (looksLikeClient && !(ts.isCallExpression(parent) && parent.expression === node)) add(node, model, 'aliased');
      }
      if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && relations.has(nameOf(node.name) ?? '')) {
        const holder = node.parent?.parent;
        if (holder && ts.isPropertyAssignment(holder) && ['include', 'select'].includes(nameOf(holder.name) ?? '')) {
          for (const model of (relations.get(nameOf(node.name) as string) as string).split('|')) add(node, model, 'relation');
        }
      }
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
        for (const { model, re } of sqlTables) if (re.test(node.text)) add(node, model, 'sql');
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return sites;
}
