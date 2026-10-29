import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

/**
 * TRAPTEST-NOTIFY-BE (KT-4): reads every runtime file under src/ (never tests) and lists each place
 * that sends a device push or writes an in-app notice, with the file, the line and the function it
 * sits in. The sender registry spec compares this list with its registry.
 *
 * What counts:
 * - `transport`: the push transport itself (the Expo SDK, the Expo push URL, a push_outbox write,
 *   a raw INSERT into the notice or outbox table, or PushDeliveryService.enqueue). Only the funnel
 *   files may do this.
 * - `pushToUser` / `pushToCoach`: NotificationsService's direct Expo push (no outbox, no quiet hours).
 * - `sendPush`: NotificationsService.sendPush, the funnel push (Mute all, push switch, quiet hours).
 * - `createNotification`: NotificationsService.createNotification, the funnel in-app notice.
 * - `notificationRow`: a direct `<db>.notification.create|createMany|upsert` that skips the gate.
 * - `emitter`: a call into a src/notifications/emitters/* class, which writes the notice and the push.
 * - `communityPush`: a call to CommunityNotificationsService.sendCommunityPush (inbox row + pushToUser).
 */
export type SendVia =
  | 'transport'
  | 'pushToUser'
  | 'pushToCoach'
  | 'sendPush'
  | 'createNotification'
  | 'notificationRow'
  | 'emitter'
  | 'communityPush';

export interface SendHit {
  /** Repo-relative path with forward slashes, e.g. src/scout/scout.service.ts. */
  file: string;
  line: number;
  /** `Class.method`, a function name, or `<module>`. */
  fn: string;
  via: SendVia;
  /** The code on that line, trimmed, for the failure message. */
  code: string;
}

const PREFILTER =
  /CommunityNotificationsService|pushToUser|pushToCoach|sendPush|createNotification|notification\s*\.\s*(create|createMany|upsert)\b|expo-server-sdk|sendPushNotificationsAsync|exp\.host|api\.expo\.dev|pushOutbox|\.enqueue\(|Emitter|insert\s+into/i;
const RAW_INSERT = /insert\s+into\s+"?(notifications?|push_outbox|push_outboxes|pushoutbox)"?/i;
const ROW_WRITE = new Set(['create', 'createMany', 'upsert']);

function isRuntimeFile(rel: string): boolean {
  if (!rel.endsWith('.ts') || rel.endsWith('.d.ts')) return false;
  if (/\.(spec|test)\.ts$/.test(rel)) return false;
  return !rel.split('/').some((part) => part === '__tests__' || part === '__mocks__' || part === '__fixtures__');
}

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'generated') continue;
      walk(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
}

function nameOf(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  return undefined;
}

function className(node: ts.Node): string {
  let p: ts.Node | undefined = node.parent;
  while (p && !ts.isClassDeclaration(p) && !ts.isClassExpression(p)) p = p.parent;
  return (p && nameOf((p as ts.ClassLikeDeclaration).name)) || '<class>';
}

/** The nearest named function the node sits in; anonymous callbacks are skipped. */
export function enclosingFunction(node: ts.Node): string {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (ts.isMethodDeclaration(p) || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)) {
      return `${className(p)}.${nameOf(p.name) ?? '<computed>'}`;
    }
    if (ts.isConstructorDeclaration(p)) return `${className(p)}.constructor`;
    if (ts.isPropertyDeclaration(p) && p.initializer && (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer))) {
      return `${className(p)}.${nameOf(p.name) ?? '<computed>'}`;
    }
    if (ts.isFunctionDeclaration(p) && p.name) return p.name.text;
    // A module-level `const name = () => ...`; a local arrow inside a method reports the method.
    if (
      ts.isVariableDeclaration(p) &&
      p.initializer &&
      (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer)) &&
      ts.isIdentifier(p.name) &&
      ts.isVariableDeclarationList(p.parent) &&
      ts.isVariableStatement(p.parent.parent) &&
      ts.isSourceFile(p.parent.parent.parent)
    ) {
      return p.name.text;
    }
  }
  return '<module>';
}

/**
 * The shared relays whose callers pick the recipient and the actor: every class in
 * src/notifications/emitters/ (methods named emit*) and CommunityNotificationsService.sendCommunityPush.
 * Returns the names that hold one in this file (constructor params, class fields, locals) and the
 * relay each holds.
 */
function relayHolders(sf: ts.SourceFile): Map<string, { via: SendVia; method: RegExp }> {
  const relayTypes = new Map<string, { via: SendVia; method: RegExp }>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const from = st.moduleSpecifier.text;
    const named = st.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    for (const el of named.elements) {
      const local = el.name.text;
      const imported = (el.propertyName ?? el.name).text;
      if (/(^|\/)emitters\/[a-z0-9-]+\.emitter$/.test(from) && /Emitter$/.test(imported)) {
        relayTypes.set(local, { via: 'emitter', method: /^emit/ });
      } else if (imported === 'CommunityNotificationsService') {
        relayTypes.set(local, { via: 'communityPush', method: /^sendCommunityPush$/ });
      }
    }
  }
  const holders = new Map<string, { via: SendVia; method: RegExp }>();
  if (relayTypes.size === 0) return holders;
  const visit = (n: ts.Node): void => {
    if ((ts.isParameter(n) || ts.isPropertyDeclaration(n) || ts.isVariableDeclaration(n)) && n.type) {
      const t = n.type;
      const typeName = ts.isTypeReferenceNode(t) && ts.isIdentifier(t.typeName) ? t.typeName.text : undefined;
      const holderName = nameOf(n.name);
      const relay = typeName ? relayTypes.get(typeName) : undefined;
      if (relay && holderName) holders.set(holderName, relay);
    }
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isNewExpression(n.initializer)) {
      const ctor = n.initializer.expression;
      const holderName = nameOf(n.name);
      const relay = ts.isIdentifier(ctor) ? relayTypes.get(ctor.text) : undefined;
      if (relay && holderName) holders.set(holderName, relay);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return holders;
}

/** The last identifier of an expression: `this.a.b` -> b, `a` -> a, `this.a?.b` -> b. */
function lastName(e: ts.Expression): string | undefined {
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  if (ts.isNonNullExpression(e) || ts.isParenthesizedExpression(e)) return lastName(e.expression);
  return undefined;
}

export function scanFile(abs: string, rel: string, text: string): SendHit[] {
  const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const hits: SendHit[] = [];
  const lines = text.split('\n');
  const inEmittersDir = rel.startsWith('src/notifications/emitters/');
  const holders = rel.endsWith('.module.ts') || inEmittersDir ? new Map<string, { via: SendVia; method: RegExp }>() : relayHolders(sf);
  const add = (node: ts.Node, via: SendVia): void => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    hits.push({ file: rel, line, fn: enclosingFunction(node), via, code: (lines[line - 1] ?? '').trim() });
  };
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && n.moduleSpecifier.text === 'expo-server-sdk') {
      add(n, 'transport');
    } else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = n.arguments[0];
      if (arg && ts.isStringLiteral(arg) && arg.text === 'expo-server-sdk') add(n, 'transport');
    } else if (
      (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) &&
      (/exp\.host\/--\/api\/v2\/push|api\.expo\.dev\/v2\/push/.test(n.text) || RAW_INSERT.test(n.text))
    ) {
      add(n, 'transport');
    } else if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const method = n.expression.name.text;
      const recv = n.expression.expression;
      const recvName = lastName(recv);
      if (method === 'sendPushNotificationsAsync' || method === 'getPushNotificationReceiptsAsync') add(n, 'transport');
      else if (recvName === 'pushOutbox' && ROW_WRITE.has(method)) add(n, 'transport');
      else if (method === 'enqueue' && recvName && /push/i.test(recvName)) add(n, 'transport');
      else if (method === 'pushToUser' || method === 'pushToCoach' || method === 'sendPush' || method === 'createNotification') {
        add(n, method);
      } else if (recvName === 'notification' && ROW_WRITE.has(method)) add(n, 'notificationRow');
      else if (recvName && holders.get(recvName)?.method.test(method)) add(n, holders.get(recvName)?.via ?? 'emitter');
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits;
}

/** Every send site in the runtime files under `<repoRoot>/src`. */
export function scanSenders(repoRoot: string): SendHit[] {
  const files: string[] = [];
  walk(path.join(repoRoot, 'src'), files);
  const hits: SendHit[] = [];
  for (const abs of files.sort()) {
    const rel = path.relative(repoRoot, abs).split(path.sep).join('/');
    if (!isRuntimeFile(rel)) continue;
    const text = fs.readFileSync(abs, 'utf8');
    if (!PREFILTER.test(text)) continue;
    hits.push(...scanFile(abs, rel, text));
  }
  return hits;
}
