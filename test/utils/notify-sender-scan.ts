import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

/**
 * TRAPTEST-NOTIFY-BE (KT-4): reads every runtime file under src/ (never tests) and lists each place
 * that sends a device push or writes an in-app notice, with the file, the line and the function it
 * sits in. The sender registry spec compares this list with its registry.
 *
 * What counts:
 * - `transport`: the push transport itself. Only the funnel files may do this:
 *   - the Expo SDK (`expo-server-sdk`): an import, an `export ... from`, `require()`, `import x = require()`
 *     or `import()` of it, and its send and receipt methods;
 *   - the funnel's own Expo client (src/notifications/push/expo-push-client.ts): importing, re-exporting,
 *     requiring or loading FetchExpoPushClient, ExpoPushClient, EXPO_SEND_URL, EXPO_RECEIPTS_URL or
 *     EXPO_PUSH_CLIENT from it (or from push-delivery.service.ts, which re-exports them), any use of those
 *     names in a function, `new` of the client, and `.send` / `.getReceipts` on a name typed with it;
 *   - the Expo push URL in a string, a push_outbox write, a raw INSERT into the notice or outbox table;
 *   - PushDeliveryService.enqueue: `.enqueue` on a receiver whose name says push, or on any name typed
 *     with PushDeliveryService (also `Pick<PushDeliveryService, 'enqueue'>` and the like).
 * - `pushToUser` / `pushToCoach`: NotificationsService's direct Expo push (no outbox, no quiet hours).
 * - `sendPush`: NotificationsService.sendPush, the funnel push (Mute all, push switch, quiet hours).
 * - `createNotification`: NotificationsService.createNotification, the funnel in-app notice.
 * - `notificationRow`: a direct `<db>.notification.create|createMany|upsert` that skips the gate.
 * - `emitter`: a call into a src/notifications/emitters/* class, which writes the notice and the push.
 * - `communityPush`: a call to CommunityNotificationsService.sendCommunityPush (inbox row + pushToUser).
 *
 * A method counts wherever it is reached, not only when it is called on the spot: `x.sendPush(...)`,
 * `x.sendPush.bind(x)`, `x['sendPush']`, `const { sendPush } = x`, and a parameter destructured the
 * same way. Not seen (say so in review): a method name built at run time (`x[name]`), and a send reached
 * through `any` or a value passed in from another file under a name and type that say nothing.
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

/** How a sendPush call sets `urgent` and `context` (one variant per branch of its argument object). */
export interface PushArgVariant {
  /** `X` when the kind is written `NotificationKind.X`; null when the kind comes from a value. */
  kindMember: string | null;
  /** The kind expression as written. */
  kindCode: string;
  /** `absent`, `true`, `false`, or `dynamic` (any other expression). */
  urgent: 'absent' | 'true' | 'false' | 'dynamic';
  /**
   * `absent` (none or null), `plain` (an object literal with no Mute all pass in it), `passes` (names
   * passesMuteAll, MUTE_ALL_PASS or safetyAlert), or `dynamic` (a value the scan cannot read).
   */
  context: 'absent' | 'plain' | 'passes' | 'dynamic';
  /** The context as a plain value when every part of it is a literal (or MUTE_ALL_PASS); else undefined. */
  contextValue?: Record<string, unknown> | null;
}

export interface PushArgs {
  /** True when the scan cannot read the argument (not an object literal, a spread of a value, or no call). */
  opaque: boolean;
  variants: PushArgVariant[];
}

export interface SendHit {
  /** Repo-relative path with forward slashes, e.g. src/scout/scout.service.ts. */
  file: string;
  line: number;
  /** `Class.method`, a function name, or `<module>`. */
  fn: string;
  via: SendVia;
  /** The code on that line, trimmed, for the failure message. */
  code: string;
  /** For a `sendPush` hit: what the call passes (LO-1186 B2: the funnel table sends these values). */
  args?: PushArgs;
}

/** NotificationsService methods that send or write a notice; each is its own `via`. */
const SEND_METHODS = ['pushToUser', 'pushToCoach', 'sendPush', 'createNotification'] as const;
type SendMethod = (typeof SEND_METHODS)[number];
/** The Expo SDK client's send and receipt methods. */
const SDK_METHODS = ['sendPushNotificationsAsync', 'getPushNotificationReceiptsAsync'];
const SDK = 'expo-server-sdk';
/** The funnel's own transport modules (repo-relative, no extension) and what they export for sending. */
export const TRANSPORT_MODULES = ['src/notifications/push/expo-push-client', 'src/notifications/push/push-delivery.service'];
const TRANSPORT_EXPORTS = ['FetchExpoPushClient', 'ExpoPushClient', 'EXPO_SEND_URL', 'EXPO_RECEIPTS_URL', 'EXPO_PUSH_CLIENT'];
const OUTBOX_CLASS = 'PushDeliveryService';
const EXPO_URL = /exp\.host\/--\/api\/v2\/push|api\.expo\.dev\/v2\/push/;
const RAW_INSERT = /insert\s+into\s+"?(notifications?|push_outbox|push_outboxes|pushoutbox)"?/i;
const ROW_WRITE = new Set(['create', 'createMany', 'upsert']);
const PASS_WORDS = /\b(passesMuteAll|MUTE_ALL_PASS|safetyAlert)\b/;

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * A file is parsed only when it names one of these. Built from the same lists the scan uses, so a form
 * the scan knows is never skipped here (LO-1186 B1).
 */
export const PREFILTER = new RegExp(
  [
    'CommunityNotificationsService',
    'Emitter',
    ...SEND_METHODS,
    ...SDK_METHODS,
    SDK,
    ...TRANSPORT_MODULES.map((m) => m.split('/').pop() as string),
    ...TRANSPORT_EXPORTS,
    OUTBOX_CLASS,
    'enqueue',
    'pushOutbox',
  ]
    .map(escape)
    .concat(['notification\\s*\\.\\s*(create|createMany|upsert)\\b', 'exp\\.host', 'api\\.expo\\.dev', 'insert\\s+into'])
    .join('|'),
  'i',
);

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
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
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

/** `./x`, `../x` and `src/x` imports as a repo-relative path with no extension; anything else as written. */
export function resolveSpecifier(rel: string, spec: string): string {
  let out = spec;
  if (spec.startsWith('.')) out = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
  return out.replace(/\.(ts|js)$/, '').replace(/\/index$/, '');
}

const isTransportModule = (rel: string, spec: string): boolean => TRANSPORT_MODULES.includes(resolveSpecifier(rel, spec));

type Relay = { via: SendVia; method: RegExp };

/**
 * The names this file imports that stand for a sender or for the transport: every class in
 * src/notifications/emitters/ (methods named emit*), CommunityNotificationsService.sendCommunityPush,
 * PushDeliveryService.enqueue, and the Expo client (FetchExpoPushClient / ExpoPushClient: send, getReceipts).
 */
function relayTypes(sf: ts.SourceFile, rel: string): Map<string, Relay> {
  const types = new Map<string, Relay>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const from = st.moduleSpecifier.text;
    const named = st.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    for (const el of named.elements) {
      const local = el.name.text;
      const imported = (el.propertyName ?? el.name).text;
      if (/(^|\/)emitters\/[a-z0-9-]+\.emitter$/.test(from) && /Emitter$/.test(imported)) {
        types.set(local, { via: 'emitter', method: /^emit/ });
      } else if (imported === 'CommunityNotificationsService') {
        types.set(local, { via: 'communityPush', method: /^sendCommunityPush$/ });
      } else if (imported === OUTBOX_CLASS) {
        types.set(local, { via: 'transport', method: /^enqueue$/ });
      } else if ((imported === 'FetchExpoPushClient' || imported === 'ExpoPushClient') && isTransportModule(rel, from)) {
        types.set(local, { via: 'transport', method: /^(send|getReceipts)$/ });
      }
    }
  }
  return types;
}

/** The first relay type named anywhere inside a node (a type such as `Pick<X, 'm'>`, or `moduleRef.get(X)`). */
function relayIn(node: ts.Node | undefined, types: Map<string, Relay>): Relay | undefined {
  if (!node || types.size === 0) return undefined;
  let found: Relay | undefined;
  const look = (n: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(n) && types.has(n.text)) found = types.get(n.text);
    else ts.forEachChild(n, look);
  };
  look(node);
  return found;
}

/** The names that hold a relay in this file (constructor params, class fields, locals) and the relay each holds. */
function relayHolders(sf: ts.SourceFile, types: Map<string, Relay>): Map<string, Relay> {
  const holders = new Map<string, Relay>();
  if (types.size === 0) return holders;
  const visit = (n: ts.Node): void => {
    if (ts.isParameter(n) || ts.isPropertyDeclaration(n) || ts.isVariableDeclaration(n)) {
      const holderName = nameOf(n.name);
      const relay = relayIn(n.type, types) ?? relayIn(n.initializer, types);
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
  if (ts.isElementAccessExpression(e)) return nameOf(e.argumentExpression);
  if (ts.isNonNullExpression(e) || ts.isParenthesizedExpression(e) || ts.isAsExpression(e)) return lastName(e.expression);
  return undefined;
}

const strip = (e: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e) ? strip(e.expression) : e;

type Props = Map<string, ts.Expression>;
/** The property sets an object literal can produce, one per branch of a conditional spread; null when unreadable. */
function variantsOf(e: ts.Expression, depth = 0): Props[] | null {
  const x = strip(e);
  if (depth > 6) return null;
  if (ts.isConditionalExpression(x)) {
    const a = variantsOf(x.whenTrue, depth + 1);
    const b = variantsOf(x.whenFalse, depth + 1);
    return a && b ? [...a, ...b] : null;
  }
  if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    const a = variantsOf(x.right, depth + 1);
    return a ? [...a, new Map()] : null;
  }
  if (!ts.isObjectLiteralExpression(x)) return null;
  let out: Props[] = [new Map()];
  for (const p of x.properties) {
    if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) {
      const key = nameOf(p.name);
      if (key === undefined) return null;
      const value = ts.isPropertyAssignment(p) ? p.initializer : p.name;
      out = out.map((m) => new Map(m).set(key, value));
    } else if (ts.isSpreadAssignment(p)) {
      const inner = variantsOf(p.expression, depth + 1);
      if (!inner) return null;
      out = out.flatMap((m) => inner.map((i) => new Map([...m, ...i])));
      if (out.length > 64) return null;
    } else {
      return null;
    }
  }
  return out;
}

/** A literal value (strings, numbers, booleans, null, nested literals, MUTE_ALL_PASS); undefined when not literal. */
function literalValue(e: ts.Expression): unknown {
  const x = strip(e);
  if (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) return x.text;
  if (ts.isNumericLiteral(x)) return Number(x.text);
  if (x.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (x.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (x.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isIdentifier(x) && x.text === 'MUTE_ALL_PASS') return { passesMuteAll: true };
  if (ts.isObjectLiteralExpression(x)) {
    const v = variantsOf(x);
    if (!v || v.length !== 1) return undefined;
    const out: Record<string, unknown> = {};
    for (const [k, val] of v[0]) {
      const lit = literalValue(val);
      if (lit === undefined) return undefined;
      out[k] = lit;
    }
    return out;
  }
  return undefined;
}

function pushArgs(call: ts.CallExpression | undefined, sf: ts.SourceFile): PushArgs {
  const arg = call?.arguments[0];
  const variants = arg ? variantsOf(arg) : null;
  if (!variants) return { opaque: true, variants: [] };
  return {
    opaque: false,
    variants: variants.map((m): PushArgVariant => {
      const kind = m.get('kind');
      const k = kind ? strip(kind) : undefined;
      const kindMember =
        k && ts.isPropertyAccessExpression(k) && ts.isIdentifier(k.expression) && k.expression.text === 'NotificationKind' ? k.name.text : null;
      const u = m.get('urgent');
      const urgent = !u ? 'absent' : strip(u).kind === ts.SyntaxKind.TrueKeyword ? 'true' : strip(u).kind === ts.SyntaxKind.FalseKeyword ? 'false' : 'dynamic';
      const c = m.get('context');
      const cx = c ? strip(c) : undefined;
      let context: PushArgVariant['context'];
      if (!cx || cx.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(cx) && cx.text === 'undefined')) context = 'absent';
      else if (PASS_WORDS.test(cx.getText(sf))) context = 'passes';
      else if (ts.isObjectLiteralExpression(cx) && variantsOf(cx) !== null) context = 'plain';
      else context = 'dynamic';
      const lit = context === 'absent' ? null : cx ? literalValue(cx) : undefined;
      return {
        kindMember,
        kindCode: kind ? kind.getText(sf) : '<no kind>',
        urgent,
        context,
        contextValue: lit === undefined ? undefined : (lit as Record<string, unknown> | null),
      };
    }),
  };
}

export function scanFile(abs: string, rel: string, text: string): SendHit[] {
  const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const hits: SendHit[] = [];
  const lines = text.split('\n');
  const inEmittersDir = rel.startsWith('src/notifications/emitters/');
  // The transport's own files: the funnel's FUNNEL_SITES rows name them at <module>; their insides are the funnel.
  const transportHome = TRANSPORT_MODULES.includes(rel.replace(/\.ts$/, ''));
  const types = relayTypes(sf, rel);
  const holders = rel.endsWith('.module.ts') || inEmittersDir ? new Map<string, Relay>() : relayHolders(sf, types);
  // In the transport's own files, holding the client or the outbox is the funnel itself.
  if (transportHome) for (const [k, r] of holders) if (r.via === 'transport') holders.delete(k);
  /** Local names bound to an Expo client value or URL import (so a use inside a function names that function). */
  const transportLocals = new Set<string>();
  const add = (node: ts.Node, via: SendVia, args?: PushArgs): void => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    hits.push({ file: rel, line, fn: enclosingFunction(node), via, code: (lines[line - 1] ?? '').trim(), ...(args ? { args } : {}) });
  };
  /** A module the transport lives in: the SDK anywhere, the funnel's Expo client outside its own files. */
  const transportSpec = (spec: string): boolean => spec === SDK || (!transportHome && isTransportModule(rel, spec));

  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const named = st.importClause?.namedBindings;
    if (transportHome || !isTransportModule(rel, st.moduleSpecifier.text) || !named || !ts.isNamedImports(named)) continue;
    for (const el of named.elements) {
      if (TRANSPORT_EXPORTS.includes((el.propertyName ?? el.name).text)) transportLocals.add(el.name.text);
    }
  }

  /** A method reached on a receiver: called, bound, passed on, or read by `x['name']`. */
  const reach = (node: ts.Node, method: string, recv: ts.Expression | undefined): void => {
    const recvName = recv ? lastName(recv) : undefined;
    const relay = (recvName ? holders.get(recvName) : undefined) ?? (recv && !transportHome ? relayIn(strip(recv), types) : undefined);
    const call = node.parent && ts.isCallExpression(node.parent) && node.parent.expression === node ? node.parent : undefined;
    if (SDK_METHODS.includes(method)) add(node, 'transport');
    else if (recvName === 'pushOutbox' && ROW_WRITE.has(method)) add(node, 'transport');
    else if (method === 'enqueue' && recvName && /push/i.test(recvName)) add(node, 'transport');
    else if ((SEND_METHODS as readonly string[]).includes(method)) {
      add(node, method as SendMethod, method === 'sendPush' ? pushArgs(call, sf) : undefined);
    } else if (recvName === 'notification' && ROW_WRITE.has(method)) add(node, 'notificationRow');
    else if (relay?.method.test(method)) add(node, relay.via);
  };

  const visit = (n: ts.Node): void => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      const spec = n.moduleSpecifier.text;
      if (spec === SDK) add(n, 'transport');
      else if (transportSpec(spec)) {
        // Importing PushDeliveryService itself (or a type such as EnqueueResult) is not a send; its enqueue is.
        const clause = ts.isImportDeclaration(n) ? n.importClause : undefined;
        const named = ts.isImportDeclaration(n) ? clause?.namedBindings : n.exportClause;
        const names =
          named && (ts.isNamedImports(named) || ts.isNamedExports(named)) ? named.elements.map((el) => (el.propertyName ?? el.name).text) : null;
        // `import * as`, `export *`, a default import, or a named transport export.
        if (names === null || clause?.name || names.some((x) => TRANSPORT_EXPORTS.includes(x))) add(n, 'transport');
      }
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) {
      const e = n.moduleReference.expression;
      if (ts.isStringLiteral(e) && transportSpec(e.text)) add(n, 'transport');
    } else if (
      ts.isCallExpression(n) &&
      (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require'))
    ) {
      const arg = n.arguments[0];
      if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) && transportSpec(arg.text)) add(n, 'transport');
    } else if (
      (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) &&
      (EXPO_URL.test(n.text) || RAW_INSERT.test(n.text))
    ) {
      add(n, 'transport');
    } else if (ts.isPropertyAccessExpression(n)) {
      reach(n, n.name.text, n.expression);
    } else if (ts.isElementAccessExpression(n)) {
      const key = nameOf(n.argumentExpression);
      if (key !== undefined) reach(n, key, n.expression);
    } else if (ts.isBindingElement(n) && ts.isObjectBindingPattern(n.parent)) {
      // `const { sendPush } = x` or `({ sendPush }: NotificationsService) => ...`.
      const key = nameOf(n.propertyName ?? n.name);
      const decl = n.parent.parent;
      const from = ts.isVariableDeclaration(decl) ? decl.initializer : undefined;
      if (key !== undefined) reach(n, key, from);
    } else if (ts.isIdentifier(n) && transportLocals.has(n.text) && enclosingFunction(n) !== '<module>' && !isDeclarationName(n)) {
      // A use of the Expo client or its URL inside a function (the import itself is the <module> hit).
      add(n, 'transport');
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits;
}

function isDeclarationName(n: ts.Identifier): boolean {
  const p = n.parent;
  return !!p && (ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ((ts.isPropertyAssignment(p) || ts.isPropertyAccessExpression(p)) && p.name === n));
}

/** One file as scanSenders reads it: runtime files only, the prefilter, then the parse. */
export function scanText(rel: string, text: string, abs = rel): SendHit[] {
  if (!isRuntimeFile(rel) || !PREFILTER.test(text)) return [];
  return scanFile(abs, rel, text);
}

/** Every send site in the runtime files under `<repoRoot>/src`. */
export function scanSenders(repoRoot: string): SendHit[] {
  const files: string[] = [];
  walk(path.join(repoRoot, 'src'), files);
  const hits: SendHit[] = [];
  for (const abs of files.sort()) {
    const rel = path.relative(repoRoot, abs).split(path.sep).join('/');
    hits.push(...scanText(rel, fs.readFileSync(abs, 'utf8'), abs));
  }
  return hits;
}
