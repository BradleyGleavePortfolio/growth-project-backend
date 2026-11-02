import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { NotificationKind } from '../../src/notifications/notification-kind';
import { MUTE_ALL_PASS, RENEWAL_OFFER } from '../../src/notifications/push/push-preferences';

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
 *     FR-1186R3 (LS-1186R3 B1): an inline import type of it too (`import('../push/expo-push-client').ExpoPushClient`,
 *     `typeof import('...')`);
 *   - the Expo push URL in a string, a push_outbox write (`x.pushOutbox.create`, `x['pushOutbox']['create']`, a
 *     copy of the delegate), a raw INSERT into the notice or outbox table;
 *   - PushDeliveryService.enqueue: `.enqueue` on a receiver whose name says push, or on any name that holds
 *     PushDeliveryService (see "holds" below);
 *   - FR-1186R2 (LO-1186R2 B1): importing PushDeliveryService itself, in any file but the funnel's own and a
 *     Nest `*.module.ts` (only NotificationsService may hold the outbox; a FUNNEL_SITES row names it).
 * - `pushToUser` / `pushToCoach`: NotificationsService's direct Expo push (no outbox, no quiet hours).
 * - `sendPush`: NotificationsService.sendPush, the funnel push (Mute all, push switch, quiet hours).
 * - `createNotification`: NotificationsService.createNotification, the funnel in-app notice.
 * - `notificationRow`: a direct `<db>.notification.create|createMany|createManyAndReturn|upsert` that skips the
 *   gate, by dot or bracket (`db['notification']['create']`, FR-1186R3, LS-1186R3 B2), or through a copy of the
 *   delegate (`const n = db.notification`, `n: Prisma.NotificationDelegate`).
 * - `emitter`: a call into a src/notifications/emitters/* class, which writes the notice and the push.
 * - `communityPush`: a call to CommunityNotificationsService.sendCommunityPush (inbox row + pushToUser).
 *
 * A method counts wherever it is reached, not only when it is called on the spot: `x.sendPush(...)`,
 * `x.sendPush.bind(x)`, `x['sendPush']`, `const { sendPush } = x`, and a parameter destructured the
 * same way. A name "holds" a relay (an emitter, the community relay, the outbox, the Expo client) when its
 * type or initializer names the imported class, a local `type` alias of it (`type Outbox = Pick<X, 'm'>`)
 * or a local interface that extends it; when it is an interface or type-literal field typed that way
 * (`deps.queue`); when it is a constructor parameter with `@Inject(X)`; and when it is a local copy of a
 * holder (`const q = this.outbox`, `const { outbox: q } = this`) (FR-1186R2, LO-1186R2 B1). FR-1186R3
 * (LO-1186R3 B1): also a get accessor or a method declared to return one, or that returns a holder
 * (`get alerts(): CoachAlertEmitter`, `alerts() { return this.made; }`, `this.alerts().emit`), what a call on a
 * holder gives (`this.relays.get('coach')?.emit`, `this.list.find(...)`), and an element of a Map or array holder
 * (`for (const e of this.emitters)`, the parameter of `this.emitters.forEach((e) => ...)`, `this.list[0]`).
 *
 * The gate fails closed (FR-1186R3): a file that imports a sender class (an emitter, CommunityNotificationsService,
 * NotificationsService) by any form (named, default, namespace, `export ... from`, `import x = require()`,
 * `require()`, `import()`, an inline `import('x').X` type) and in which the scan reads no send of that class is an
 * `unread` hit at the import. The registry checks report it unless IMPORTS_WITHOUT_SEND (the registry) names the
 * file and class with why (it only holds the class or hands it on). Nest `*.module.ts` files, the class's own file
 * and, for the emitters, src/notifications/emitters/ itself are not callers. The prefilter (PREFILTER) is never
 * narrower than this walker: every name the walker keys on admits the file.
 * Not seen (say so in review): a send in a form the walker cannot read (a method name built at run time
 * (`x[name]`), `Reflect.get(x, 'sendPush')`, assignment destructuring (`({ sendPush: send } = x)`)) in a file where
 * the scan reads another send of the same class; and a sender the file never imports (an `@Inject('TOKEN')`
 * string token, `any`, or a value passed in from another file under a name and type that say nothing).
 *
 * What a sendPush call passes (FR-1186R2, LS-1186R2 B1 and LO-1186R2 B2): the kind is read as a value when
 * it is spelled statically (`NotificationKind.X`, `NotificationKind['X']`, a string or template literal,
 * or a `const` of one of those); the context is read as a value when it is a literal or a push-preferences
 * constant (MUTE_ALL_PASS, RENEWAL_OFFER, imported under any name). Anything else is a value the scan
 * cannot read, and the registry checks name it with its file and line.
 */
export type SendVia =
  | 'transport'
  | 'pushToUser'
  | 'pushToCoach'
  | 'sendPush'
  | 'createNotification'
  | 'notificationRow'
  | 'emitter'
  | 'communityPush'
  | 'unread';

/** FR-1186R3: the sender kinds an `unread` hit stands for (an emitter class, the community relay, NotificationsService). */
export type UnreadKind = 'emitter' | 'communityPush' | 'notices';

/** How a sendPush call sets `urgent` and `context` (one variant per branch of its argument object). */
export interface PushArgVariant {
  /** `X` when the kind is written `NotificationKind.X` or `NotificationKind['X']`; else null. */
  kindMember: string | null;
  /**
   * FR-1186R2 (LS-1186R2 B1): true when the code spells one fixed kind (an enum member, a string or template
   * literal, or a const of one); false when the kind comes from a value chosen at run time.
   */
  kindStatic: boolean;
  /** The kind's value when kindStatic (a string; it may not be a NotificationKind); null otherwise or for an unknown member. */
  kindValue: string | null;
  /** The kind expression as written. */
  kindCode: string;
  /** `absent`, `true`, `false`, or `dynamic` (any other expression). */
  urgent: 'absent' | 'true' | 'false' | 'dynamic';
  /**
   * `absent` (none or null), `plain` (an object literal with no Mute all pass in it), `passes` (names
   * passesMuteAll, MUTE_ALL_PASS or safetyAlert), `offer` (a renewal offer: RENEWAL_OFFER or renewalOffer,
   * which Mute all stops and which needs the person's yes; FR-1186R2, LO-1186R2 B2), or `dynamic` (a value
   * the scan cannot read).
   */
  context: 'absent' | 'plain' | 'passes' | 'offer' | 'dynamic';
  /** The context as a plain value when every part of it is a literal (or a push-preferences constant); else undefined. */
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
  /** For an `emitter` or `communityPush` hit: the imported class it reaches (e.g. CoachAlertEmitter) and the method. */
  relay?: { name: string; method: string };
  /**
   * FR-1186R2 (LO-1186R2 C1): for an `emitter` hit, the call's first argument, one variant per branch: each
   * property's literal value, or `{ code }` when it is a value the scan cannot read. Opaque when not an object.
   */
  callArgs?: CallArgs;
  /**
   * FR-1186R3 (the gate fails closed): for an `unread` hit, the sender class this file imports (by any import form)
   * with no send of it the scan reads in the file; the hit sits on the import.
   */
  unread?: { name: string; kind: UnreadKind; form: string };
}

/** One property of an emitter call's argument: its literal value, or only its code. */
export type ArgProp = { value: unknown; code: string } | { code: string };
export interface CallArgs {
  opaque: boolean;
  variants: Array<Record<string, ArgProp>>;
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
const ROW_WRITE = new Set(['create', 'createMany', 'createManyAndReturn', 'upsert']);
const ROW_WRITE_RE = /^(create|createMany|createManyAndReturn|upsert)$/;
const PASS_WORDS = /\b(passesMuteAll|MUTE_ALL_PASS|safetyAlert)\b/;
const OFFER_WORDS = /\b(renewalOffer|RENEWAL_OFFER)\b/;
/** The push-preferences constants a context may name (their real values, so a change there is read here). */
const PREF_CONSTANTS: Record<string, unknown> = { MUTE_ALL_PASS, RENEWAL_OFFER };
const KIND_VALUES = NotificationKind as Record<string, string>;

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * A file is parsed only when it names one of these. Built from the same lists the scan uses, so a form
 * the scan knows is never skipped here (LO-1186 B1). FR-1186R3 (LS-1186R3 B2): never narrower than the walker:
 * any mention of `notification` (the notice table's delegate in any spelling, `x['notification']['create']`,
 * NotificationsService, createNotification, CommunityNotificationsService and their modules) or `emit` (every
 * emitter class, module and method) admits the file. These only add files; fr-1186r3-fail-closed.spec.ts proves the
 * whole of src/ parsed without the prefilter gives the same hits.
 */
export const PREFILTER = new RegExp(
  [
    'notification',
    'emit',
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

type Relay = { via: SendVia; method: RegExp; name: string };

const EMITTER_MODULE = /(^|\/)emitters\/[a-z0-9-]+\.emitter$/;
const COMMUNITY_CLASS = 'CommunityNotificationsService';
const COMMUNITY_MODULE = 'src/community/notifications/community-notifications.service';
const NOTICES_CLASS = 'NotificationsService';
const NOTICES_MODULE = 'src/notifications/notifications.service';
/**
 * FR-1186R3: the notice and outbox tables' Prisma delegates, by property name and by type, so a delegate held under
 * another name (`const n = tx.notification; n.create(...)`, `n: Prisma.NotificationDelegate`) is still read.
 */
const NOTICE_ROW: Relay = { via: 'notificationRow', method: ROW_WRITE_RE, name: 'notification' };
const OUTBOX_ROW: Relay = { via: 'transport', method: ROW_WRITE_RE, name: 'pushOutbox' };
const DELEGATES = new Map<string, Relay>([
  ['notification', NOTICE_ROW],
  ['pushOutbox', OUTBOX_ROW],
]);
const DELEGATE_TYPES = new Map<string, Relay>([
  ['NotificationDelegate', NOTICE_ROW],
  ['PushOutboxDelegate', OUTBOX_ROW],
]);

/** The relay an imported name stands for, if any (shared by every import form the walker follows). */
function relayFor(imported: string, from: string, rel: string): Relay | undefined {
  // FR-1186R3: an *Emitter class from any src/notifications module (a barrel too), not only its own file.
  if (/Emitter$/.test(imported) && (EMITTER_MODULE.test(from) || resolveSpecifier(rel, from).startsWith('src/notifications/'))) {
    return { via: 'emitter', method: /^emit/, name: imported };
  }
  if (imported === COMMUNITY_CLASS) return { via: 'communityPush', method: /^sendCommunityPush$/, name: imported };
  if (imported === OUTBOX_CLASS) return { via: 'transport', method: /^enqueue$/, name: imported };
  if ((imported === 'FetchExpoPushClient' || imported === 'ExpoPushClient') && isTransportModule(rel, from)) {
    return { via: 'transport', method: /^(send|getReceipts)$/, name: imported };
  }
  return undefined;
}

/** `import('x')` as a type: its module specifier, and the last name of its qualifier (`import('x').A.B` -> B). */
function importTypeParts(n: ts.ImportTypeNode): { spec: string | undefined; name: string | undefined } {
  const arg = n.argument;
  const spec = ts.isLiteralTypeNode(arg) && ts.isStringLiteral(arg.literal) ? arg.literal.text : undefined;
  const q = n.qualifier;
  return { spec, name: q ? (ts.isIdentifier(q) ? q.text : q.right.text) : undefined };
}

/** FR-1186R3 (LS-1186R3 B1): the relay each inline import type in a file names (`import('../push/expo-push-client').ExpoPushClient`). */
const IMPORT_TYPE_RELAY = new WeakMap<ts.Node, Relay>();

/**
 * The names this file imports that stand for a sender or for the transport: every class in
 * src/notifications/emitters/ (methods named emit*), CommunityNotificationsService.sendCommunityPush,
 * PushDeliveryService.enqueue, and the Expo client (FetchExpoPushClient / ExpoPushClient: send, getReceipts).
 * FR-1186R3: also an inline import type of one (LS-1186R3 B1) and the Prisma delegate types of the notice and
 * outbox tables.
 */
function relayTypes(sf: ts.SourceFile, rel: string): Map<string, Relay> {
  const types = new Map<string, Relay>(DELEGATE_TYPES);
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const from = st.moduleSpecifier.text;
    const named = st.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    for (const el of named.elements) {
      const relay = relayFor((el.propertyName ?? el.name).text, from, rel);
      if (relay) types.set(el.name.text, relay);
    }
  }
  const inline = (n: ts.Node): void => {
    if (ts.isImportTypeNode(n)) {
      const { spec, name } = importTypeParts(n);
      const relay = spec !== undefined && name !== undefined ? relayFor(name, spec, rel) : undefined;
      if (relay) IMPORT_TYPE_RELAY.set(n, relay);
    }
    ts.forEachChild(n, inline);
  };
  inline(sf);
  // FR-1186R2 (LO-1186R2 B1): a local `type` alias of a relay (`type Outbox = Pick<PushDeliveryService, 'enqueue'>`)
  // or a local interface that extends one is that relay too; an alias of an alias is followed.
  for (let pass = 0, grew = true; grew && pass < 8; pass++) {
    grew = false;
    const visit = (n: ts.Node): void => {
      let relay: Relay | undefined;
      if (ts.isTypeAliasDeclaration(n)) relay = relayIn(n.type, types);
      else if (ts.isInterfaceDeclaration(n)) relay = (n.heritageClauses ?? []).map((h) => relayIn(h, types)).find((r) => !!r);
      if (relay && (ts.isTypeAliasDeclaration(n) || ts.isInterfaceDeclaration(n)) && !types.has(n.name.text)) {
        types.set(n.name.text, relay);
        grew = true;
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return types;
}

/** The first relay type named anywhere inside a node (a type such as `Pick<X, 'm'>`, `import('x').X`, or `moduleRef.get(X)`). */
function relayIn(node: ts.Node | undefined, types: Map<string, Relay>): Relay | undefined {
  if (!node) return undefined;
  let found: Relay | undefined;
  const look = (n: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(n) && types.has(n.text)) found = types.get(n.text);
    else if (IMPORT_TYPE_RELAY.has(n)) found = IMPORT_TYPE_RELAY.get(n);
    else ts.forEachChild(n, look);
  };
  look(node);
  return found;
}

/**
 * FR-1186R3 (LO-1186R3 B1): the relay an expression stands for: a holder's name (`a`, `this.a`, `x['a']`); a getter
 * or a method that returns one (`this.a`, `this.a()`); what a call on a holder gives (`this.relays.get('k')`,
 * `this.list.find(...)`), but not a send on it (`this.a.emit(...)` gives its result); an element of one
 * (`this.list[0]`); an awaited one; and the notice or outbox table's Prisma delegate (`tx.notification`).
 */
function holderOf(e: ts.Expression | undefined, holders: Map<string, Relay>, depth = 0): Relay | undefined {
  if (!e || depth > 8) return undefined;
  const x = strip(e);
  const next = (y: ts.Expression): Relay | undefined => holderOf(y, holders, depth + 1);
  if (ts.isAwaitExpression(x)) return next(x.expression);
  if (ts.isIdentifier(x)) return holders.get(x.text);
  if (ts.isPropertyAccessExpression(x)) return holders.get(x.name.text) ?? DELEGATES.get(x.name.text) ?? next(x.expression);
  if (ts.isElementAccessExpression(x)) {
    const key = nameOf(x.argumentExpression);
    return (key !== undefined ? (holders.get(key) ?? DELEGATES.get(key)) : undefined) ?? next(x.expression);
  }
  if (ts.isCallExpression(x)) {
    const callee = strip(x.expression);
    const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isElementAccessExpression(callee) ? nameOf(callee.argumentExpression) : undefined;
    const relay = next(callee);
    return relay && name !== undefined && relay.method.test(name) ? undefined : relay;
  }
  if (ts.isArrowFunction(x) && !ts.isBlock(x.body)) return next(x.body);
  return undefined;
}

/** Every name a binding binds (`a`, `{ a, b: c }`, `[a, [b]]`). */
function boundNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((el) => (ts.isOmittedExpression(el) ? [] : boundNames(el.name)));
}

/** Array and promise methods whose callback gets the holder's element (or value) as its parameter. */
const ELEMENT_METHODS = new Set(['forEach', 'map', 'flatMap', 'filter', 'find', 'findLast', 'some', 'every', 'reduce', 'reduceRight', 'then']);

/**
 * The names that hold a relay in this file and the relay each holds: constructor params, class fields, locals,
 * interface and type-literal fields (`deps.queue`), a param with `@Inject(X)`, and a local copy of a holder
 * (`const q = this.outbox`, `const { outbox: q } = this`), followed until nothing new is found.
 * FR-1186R3 (LO-1186R3 B1): also a get accessor, a method or a function by its declared return type or by what it
 * returns (`get alerts(): CoachAlertEmitter`, `alerts() { return this.made; }`), an element of a Map or an array
 * held that way (`this.relays.get('k')`, a for-of variable, an array method's callback parameter), and a copy of
 * the notice or outbox table's delegate.
 */
function relayHolders(sf: ts.SourceFile, types: Map<string, Relay>): Map<string, Relay> {
  const holders = new Map<string, Relay>();
  const fromHolder = (e: ts.Expression | undefined): Relay | undefined => holderOf(e, holders);
  let grew = true;
  const put = (name: string | undefined, relay: Relay | undefined): void => {
    if (!name || !relay || holders.has(name)) return;
    holders.set(name, relay);
    grew = true;
  };
  /** What a function body returns, when that is a holder (returns inside nested functions are not its own). */
  const returned = (body: ts.Node | undefined): Relay | undefined => {
    let found: Relay | undefined;
    const look = (n: ts.Node): void => {
      if (found || ts.isFunctionLike(n)) return;
      if (ts.isReturnStatement(n)) found = fromHolder(n.expression);
      else ts.forEachChild(n, look);
    };
    if (body) ts.forEachChild(body, look);
    return found;
  };
  const visit = (n: ts.Node): void => {
    if (ts.isGetAccessorDeclaration(n) || ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n) || ts.isMethodSignature(n)) {
      put(nameOf(n.name), relayIn(n.type, types) ?? ('body' in n ? returned(n.body) : undefined));
    }
    if (ts.isVariableDeclaration(n) && ts.isVariableDeclarationList(n.parent) && ts.isForOfStatement(n.parent.parent)) {
      const relay = fromHolder(n.parent.parent.expression);
      for (const name of boundNames(n.name)) put(name, relay);
    }
    if (
      ts.isParameter(n) &&
      (ts.isArrowFunction(n.parent) || ts.isFunctionExpression(n.parent)) &&
      ts.isCallExpression(n.parent.parent) &&
      n.parent.parent.arguments.some((a) => a === n.parent)
    ) {
      const callee = strip(n.parent.parent.expression);
      if (ts.isPropertyAccessExpression(callee) && ELEMENT_METHODS.has(callee.name.text)) {
        const relay = fromHolder(callee.expression);
        for (const name of boundNames(n.name)) put(name, relay);
      }
    }
    if (ts.isParameter(n) || ts.isPropertyDeclaration(n) || ts.isVariableDeclaration(n)) {
      const decorators = ts.canHaveDecorators(n) ? (ts.getDecorators(n) ?? []) : [];
      const injected = decorators.map((d) => relayIn(d.expression, types)).find((r) => !!r);
      put(nameOf(n.name), relayIn(n.type, types) ?? relayIn(n.initializer, types) ?? injected ?? fromHolder(n.initializer));
    } else if (ts.isPropertySignature(n)) {
      put(nameOf(n.name), relayIn(n.type, types));
    } else if (ts.isBindingElement(n) && ts.isObjectBindingPattern(n.parent) && ts.isIdentifier(n.name)) {
      const key = nameOf(n.propertyName ?? n.name);
      if (key !== undefined) put(n.name.text, holders.get(key) ?? DELEGATES.get(key));
    }
    ts.forEachChild(n, visit);
  };
  for (let pass = 0; grew && pass < 8; pass++) {
    grew = false;
    visit(sf);
  }
  return holders;
}

/**
 * What a file's names stand for, for reading a sendPush argument as values (FR-1186R2): the local names of
 * NotificationKind, the push-preferences constants it imports (under any name), and its own `const`s
 * (a name declared twice in the file is not read).
 */
interface Env {
  kindNames: Set<string>;
  prefs: Map<string, unknown>;
  consts: Map<string, ts.Expression | null>;
}

function envOf(sf: ts.SourceFile): Env {
  // The bare name NotificationKind is the enum too (a scratch file in the self-test may not import it).
  const env: Env = { kindNames: new Set(['NotificationKind']), prefs: new Map(), consts: new Map() };
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const from = st.moduleSpecifier.text;
    const named = st.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    for (const el of named.elements) {
      const imported = (el.propertyName ?? el.name).text;
      if (/(^|\/)notification-kind$/.test(from) && imported === 'NotificationKind') env.kindNames.add(el.name.text);
      if (/(^|\/)push-preferences$/.test(from) && imported in PREF_CONSTANTS) env.prefs.set(el.name.text, PREF_CONSTANTS[imported]);
    }
  }
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && ts.isVariableDeclarationList(n.parent) && n.parent.flags & ts.NodeFlags.Const) {
      env.consts.set(n.name.text, env.consts.has(n.name.text) ? null : (n.initializer ?? null));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return env;
}

/** The kind a sendPush argument spells: one fixed value (static) or a value chosen at run time. */
function readKind(e: ts.Expression | undefined, env: Env, depth = 0): { kindStatic: boolean; kindValue: string | null; kindMember: string | null } {
  const dynamic = { kindStatic: false, kindValue: null, kindMember: null };
  if (!e || depth > 4) return dynamic;
  const x = strip(e);
  const member = (m: string): { kindStatic: boolean; kindValue: string | null; kindMember: string | null } => ({
    kindStatic: true,
    kindValue: Object.prototype.hasOwnProperty.call(KIND_VALUES, m) ? KIND_VALUES[m] : null,
    kindMember: m,
  });
  if (ts.isPropertyAccessExpression(x) && ts.isIdentifier(x.expression) && env.kindNames.has(x.expression.text)) return member(x.name.text);
  if (ts.isElementAccessExpression(x) && ts.isIdentifier(x.expression) && env.kindNames.has(x.expression.text)) {
    const key = literalValue(x.argumentExpression, env);
    return typeof key === 'string' ? member(key) : dynamic;
  }
  if (ts.isIdentifier(x) && !env.prefs.has(x.text)) {
    const init = env.consts.get(x.text);
    if (init) return readKind(init, env, depth + 1);
  }
  const lit = literalValue(x, env);
  return typeof lit === 'string' ? { kindStatic: true, kindValue: lit, kindMember: null } : dynamic;
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

/**
 * A literal value (strings, numbers, booleans, null, nested literals, a push-preferences constant, a file
 * `const` of one of these); undefined when not literal.
 */
function literalValue(e: ts.Expression, env?: Env, depth = 0): unknown {
  const x = strip(e);
  if (depth > 4) return undefined;
  if (ts.isIdentifier(x) && env) {
    if (env.prefs.has(x.text)) return env.prefs.get(x.text);
    const init = env.consts.get(x.text);
    if (init) return literalValue(init, env, depth + 1);
    if (env.consts.has(x.text)) return undefined;
  }
  if (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) return x.text;
  if (ts.isNumericLiteral(x)) return Number(x.text);
  if (x.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (x.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (x.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isIdentifier(x) && x.text in PREF_CONSTANTS) return PREF_CONSTANTS[x.text];
  if (ts.isObjectLiteralExpression(x)) {
    const v = variantsOf(x);
    if (!v || v.length !== 1) return undefined;
    const out: Record<string, unknown> = {};
    for (const [k, val] of v[0]) {
      const lit = literalValue(val, env, depth + 1);
      if (lit === undefined) return undefined;
      out[k] = lit;
    }
    return out;
  }
  return undefined;
}

/** A context value that passes Mute all (MUTE_ALL_PASS, or a safety alert key; owner #168-18 and #171-3). */
const passesValue = (v: unknown): boolean =>
  !!v && typeof v === 'object' && ((v as { passesMuteAll?: unknown }).passesMuteAll === true || 'safetyAlert' in (v as object));
const offerValue = (v: unknown): boolean => !!v && typeof v === 'object' && (v as { renewalOffer?: unknown }).renewalOffer === true;

function pushArgs(call: ts.CallExpression | undefined, sf: ts.SourceFile, env: Env): PushArgs {
  const arg = call?.arguments[0];
  const variants = arg ? variantsOf(arg) : null;
  if (!variants) return { opaque: true, variants: [] };
  return {
    opaque: false,
    variants: variants.map((m): PushArgVariant => {
      const kind = m.get('kind');
      const k = readKind(kind, env);
      const u = m.get('urgent');
      const urgent = !u ? 'absent' : strip(u).kind === ts.SyntaxKind.TrueKeyword ? 'true' : strip(u).kind === ts.SyntaxKind.FalseKeyword ? 'false' : 'dynamic';
      const c = m.get('context');
      const cx = c ? strip(c) : undefined;
      let context: PushArgVariant['context'];
      const read = cx ? literalValue(cx, env) : undefined;
      if (!cx || cx.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(cx) && cx.text === 'undefined')) context = 'absent';
      else if (PASS_WORDS.test(cx.getText(sf)) || passesValue(read)) context = 'passes';
      else if (OFFER_WORDS.test(cx.getText(sf)) || offerValue(read)) context = 'offer';
      else if (ts.isObjectLiteralExpression(cx) && variantsOf(cx) !== null) context = 'plain';
      else context = 'dynamic';
      const lit = context === 'absent' ? null : read;
      return {
        ...k,
        kindCode: kind ? kind.getText(sf) : '<no kind>',
        urgent,
        context,
        contextValue: lit === undefined ? undefined : (lit as Record<string, unknown> | null),
      };
    }),
  };
}

/** FR-1186R2 (LO-1186R2 C1): an emitter call's first argument, each property as a literal value or its code. */
function callArgs(call: ts.CallExpression | undefined, sf: ts.SourceFile, env: Env): CallArgs {
  const arg = call?.arguments[0];
  const variants = arg ? variantsOf(arg) : null;
  if (!variants) return { opaque: true, variants: [] };
  return {
    opaque: false,
    variants: variants.map((m) => {
      const out: Record<string, ArgProp> = {};
      for (const [key, e] of m) {
        const value = literalValue(e, env);
        out[key] = value === undefined ? { code: e.getText(sf) } : { value, code: e.getText(sf) };
      }
      return out;
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
  const env = envOf(sf);
  const holders = rel.endsWith('.module.ts') || inEmittersDir ? new Map<string, Relay>() : relayHolders(sf, types);
  // In the transport's own files, holding the client or the outbox is the funnel itself.
  if (transportHome) for (const [k, r] of holders) if (r.via === 'transport') holders.delete(k);
  /** Local names bound to an Expo client value or URL import (so a use inside a function names that function). */
  const transportLocals = new Set<string>();
  const add = (node: ts.Node, via: SendVia, args?: PushArgs, more?: Pick<SendHit, 'relay' | 'callArgs' | 'unread'>): void => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    hits.push({ file: rel, line, fn: enclosingFunction(node), via, code: (lines[line - 1] ?? '').trim(), ...(args ? { args } : {}), ...(more ?? {}) });
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
    // FR-1186R3 (LO-1186R3 B1): through a getter, a method's return, a Map or an array element (holderOf).
    const relay = holderOf(recv, holders) ?? (recv && !transportHome ? relayIn(strip(recv), types) : undefined);
    const call = node.parent && ts.isCallExpression(node.parent) && node.parent.expression === node ? node.parent : undefined;
    if (SDK_METHODS.includes(method)) add(node, 'transport');
    else if (recvName === 'pushOutbox' && ROW_WRITE.has(method)) add(node, 'transport');
    else if (method === 'enqueue' && recvName && /push/i.test(recvName)) add(node, 'transport');
    else if ((SEND_METHODS as readonly string[]).includes(method)) {
      add(node, method as SendMethod, method === 'sendPush' ? pushArgs(call, sf, env) : undefined);
    } else if (recvName === 'notification' && ROW_WRITE.has(method)) add(node, 'notificationRow');
    else if (relay?.method.test(method)) {
      const plain = relay.via === 'transport' || relay.via === 'notificationRow';
      add(node, relay.via, undefined, plain ? undefined : { relay: { name: relay.name, method }, ...(relay.via === 'emitter' ? { callArgs: callArgs(call, sf, env) } : {}) });
    }
  };

  /** FR-1186R3: every import of a sender class, by any import form (the fail-closed check below). */
  const senderImports: Array<{ node: ts.Node; name: string; kind: UnreadKind; form: string }> = [];
  const noteImport = (node: ts.Node, spec: string, names: string[] | null, form: string): void => {
    if (rel.endsWith('.module.ts')) return;
    for (const s of sendersFrom(rel, spec, names)) senderImports.push({ node, ...s, form });
  };

  const visit = (n: ts.Node): void => {
    const imported = importForm(n);
    if (imported) noteImport(n, imported.spec, imported.names, imported.form);
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      const spec = n.moduleSpecifier.text;
      if (spec === SDK) add(n, 'transport');
      else if (transportSpec(spec)) {
        // A type such as EnqueueResult is not a send. FR-1186R2 (LO-1186R2 B1): PushDeliveryService itself is, outside
        // a Nest module file: only the funnel (NotificationsService, a FUNNEL_SITES row) may hold the outbox.
        const clause = ts.isImportDeclaration(n) ? n.importClause : undefined;
        const named = ts.isImportDeclaration(n) ? clause?.namedBindings : n.exportClause;
        const names =
          named && (ts.isNamedImports(named) || ts.isNamedExports(named)) ? named.elements.map((el) => (el.propertyName ?? el.name).text) : null;
        const outbox = !!names?.includes(OUTBOX_CLASS) && !rel.endsWith('.module.ts');
        // `import * as`, `export *`, a default import, a named transport export, or the outbox class.
        if (names === null || clause?.name || outbox || names.some((x) => TRANSPORT_EXPORTS.includes(x))) add(n, 'transport');
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
    } else if (ts.isImportTypeNode(n)) {
      // FR-1186R3 (LS-1186R3 B1): `import('../push/expo-push-client').ExpoPushClient` as a type is an import of it.
      const { spec, name } = importTypeParts(n);
      if (spec !== undefined && transportSpec(spec)) {
        const outbox = name === OUTBOX_CLASS && !rel.endsWith('.module.ts');
        if (spec === SDK || name === undefined || outbox || TRANSPORT_EXPORTS.includes(name)) add(n, 'transport');
      }
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
  // FR-1186R3: the gate fails closed. A file that imports a sender class by any import form, and in which the scan
  // reads no send of it, is an `unread` hit on the import: the send is in a form the walker cannot read, or the
  // file only holds it (IMPORTS_WITHOUT_SEND in the registry names those, with why).
  const sends = (u: { name: string; kind: UnreadKind }): boolean =>
    u.kind === 'notices'
      ? hits.some((h) => (SEND_METHODS as readonly string[]).includes(h.via))
      : hits.some((h) => h.via === u.kind && (u.name.endsWith('.emitter') || h.relay?.name === u.name));
  for (const u of senderImports) {
    if (!sends(u)) add(u.node, 'unread', undefined, { unread: { name: u.name, kind: u.kind, form: u.form } });
  }
  return hits;
}

/** FR-1186R3: an import of a module by any form: its specifier, the names it takes (null: the whole module) and the form. */
function importForm(n: ts.Node): { spec: string; names: string[] | null; form: string } | undefined {
  if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
    const c = n.importClause;
    const named = c?.namedBindings;
    if (c?.name || !named || !ts.isNamedImports(named)) return { spec: n.moduleSpecifier.text, names: null, form: c?.name ? 'default import' : named ? 'namespace import' : 'side-effect import' };
    return { spec: n.moduleSpecifier.text, names: named.elements.map((el) => (el.propertyName ?? el.name).text), form: 'named import' };
  }
  if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
    const named = n.exportClause;
    return { spec: n.moduleSpecifier.text, names: named && ts.isNamedExports(named) ? named.elements.map((el) => (el.propertyName ?? el.name).text) : null, form: 'export from' };
  }
  if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && ts.isStringLiteral(n.moduleReference.expression)) {
    return { spec: n.moduleReference.expression.text, names: null, form: 'import = require' };
  }
  if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require'))) {
    const arg = n.arguments[0];
    if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
      return { spec: arg.text, names: null, form: n.expression.kind === ts.SyntaxKind.ImportKeyword ? 'dynamic import()' : 'require()' };
    }
  }
  if (ts.isImportTypeNode(n)) {
    const { spec, name } = importTypeParts(n);
    if (spec !== undefined) return { spec, names: name !== undefined ? [name] : null, form: 'inline import type' };
  }
  return undefined;
}

/**
 * FR-1186R3: the sender classes an import brings in: an emitter class (or a whole emitter module), the community
 * relay, NotificationsService (the notice table's writer). A sender's own files and its own directory's insides
 * (src/notifications/emitters/ for the emitters) are the sender itself, not a caller.
 */
function sendersFrom(rel: string, spec: string, names: string[] | null): Array<{ name: string; kind: UnreadKind }> {
  const r = resolveSpecifier(rel, spec);
  const self = rel.replace(/\.ts$/, '');
  const out: Array<{ name: string; kind: UnreadKind }> = [];
  if (!rel.startsWith('src/notifications/emitters/')) {
    if (names === null && EMITTER_MODULE.test(r)) out.push({ name: path.posix.basename(r), kind: 'emitter' });
    for (const x of names ?? []) if (relayFor(x, spec, rel)?.via === 'emitter') out.push({ name: x, kind: 'emitter' });
  }
  if (self !== COMMUNITY_MODULE && ((names === null && r === COMMUNITY_MODULE) || names?.includes(COMMUNITY_CLASS))) out.push({ name: COMMUNITY_CLASS, kind: 'communityPush' });
  if (self !== NOTICES_MODULE && ((names === null && r === NOTICES_MODULE) || names?.includes(NOTICES_CLASS))) out.push({ name: NOTICES_CLASS, kind: 'notices' });
  return out;
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
