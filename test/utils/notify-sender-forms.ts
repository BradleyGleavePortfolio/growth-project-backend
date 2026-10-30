import type { SendVia } from './notify-sender-scan';

/**
 * LS-1186 B1 / LO-1186 B1 (FR-1186): the ways a runtime file can reach a sender or the push transport, each
 * with the hits the KT-4 scan (test/utils/notify-sender-scan.ts) must report for it. The spec
 * src/notifications/__tests__/sender-scan-forms.spec.ts writes each one into a scratch repo (never into
 * this repo's src/) and runs the real scanSenders on it, so the prefilter, the runtime-file rule and the
 * parse are the ones the sender registry spec uses.
 *
 * `at` is a piece of the line the hit must sit on. An empty `expect` means the scan must report nothing.
 * `finds` (FR-1186R2): what the registry spec's checks (directTransport, unregistered, funnelArgFindings) must
 * then report: a message naming `file:line` of the `at` piece and saying `says`. A form written at a real
 * sender's path (WB, the WorkoutBuilderService row) is checked against that row's funnel entries.
 * Add a row here when you find a new way to send; the class-first path list in b#1186 names these ids.
 */
export interface SendForm {
  id: string;
  /** The finding that asked for it, or `control` (already seen before FR-1186) or `negative`. */
  from: string;
  /** Repo-relative path the text is written to. */
  file: string;
  text: string;
  expect: Array<{ fn: string; via: SendVia; at: string }>;
  finds?: Array<{ at: string; says: string }>;
}

const F = 'src/kt4-forms';
/** FR-1186R2: the WorkoutBuilderService row's file (registry funnel: one plain workout_assigned push). */
const WB = 'src/workout-builder/workout-builder.service.ts';
/** The emitAssignmentPush send at WB with `kind` and `extra` spelled as given (one line: the hit line). */
const wb = (head: string, kind: string, extra = ''): string => `import { NotificationKind } from '../notifications/notification-kind';
import type { NotificationsService } from '../notifications/notifications.service';
${head}
export class WorkoutBuilderService {
  private emitAssignmentPush(notifications: NotificationsService, clientId: string, body: string, deepLink: string, pick: () => string, ctx: unknown) {
    void [pick, ctx, NotificationKind];
    void notifications.sendPush({ user_id: clientId, kind: ${kind}, body, deep_link: deepLink${extra} });
  }
}
`;
const ENQ = `({ userId: 'u', kind: 'message_received', title: '', body: '', data: {}, collapseKey: 'k', timeZone: null })`;

export const SEND_FORMS: SendForm[] = [
  // ── LS-1186 B1 ─────────────────────────────────────────────────────────────────────────────────
  {
    id: 'bound-sendPush',
    from: 'LS-1186 B1 (a)',
    file: `${F}/bound-sendpush.ts`,
    text: `import type { NotificationsService } from '../notifications/notifications.service';
export function boundSender(notices: Pick<NotificationsService, 'sendPush'>) {
  const deliver = notices.sendPush.bind(notices);
  return deliver({ user_id: 'u', kind: 'message_received', body: '' });
}
`,
    expect: [{ fn: 'boundSender', via: 'sendPush', at: 'notices.sendPush.bind' }],
  },
  {
    id: 'pick-outbox-enqueue',
    from: 'LS-1186 B1 (b)',
    file: `${F}/pick-outbox-enqueue.ts`,
    text: `import type { PushDeliveryService } from '../notifications/push/push-delivery.service';
export function aliasedTransport(delivery: Pick<PushDeliveryService, 'enqueue'>) {
  return delivery.enqueue({ userId: 'u', kind: 'message_received', title: '', body: '', data: {}, collapseKey: 'k', timeZone: null });
}
`,
    expect: [{ fn: 'aliasedTransport', via: 'transport', at: 'delivery.enqueue(' }],
  },
  {
    id: 'typed-outbox-field-enqueue',
    from: 'LS-1186 B1 (b)',
    file: `${F}/typed-outbox-field.ts`,
    text: `import { PushDeliveryService } from '../notifications/push/push-delivery.service';
export class Sideways {
  constructor(private readonly outbox: PushDeliveryService) {}
  async go() {
    await this.outbox.enqueue({ userId: 'u', kind: 'message_received', title: '', body: '', data: {}, collapseKey: 'k', timeZone: null });
  }
}
`,
    expect: [{ fn: 'Sideways.go', via: 'transport', at: 'this.outbox.enqueue(' }],
  },
  {
    id: 'aliased-expo-client',
    from: 'LS-1186 B1 (c)',
    file: `${F}/aliased-expo-client.ts`,
    text: `import { FetchExpoPushClient as RawPushClient } from '../notifications/push/expo-push-client';
export function rawImportedTransport(client: RawPushClient) {
  return client.send([{ to: 'ExponentPushToken[x]', body: 'b' }], new AbortController().signal);
}
`,
    expect: [
      { fn: '<module>', via: 'transport', at: 'import { FetchExpoPushClient as RawPushClient }' },
      { fn: 'rawImportedTransport', via: 'transport', at: 'client.send(' },
    ],
  },
  // ── LO-1186 B1 ─────────────────────────────────────────────────────────────────────────────────
  {
    id: 'expo-url-constant',
    from: 'LO-1186 B1 (a)',
    file: `${F}/expo-url-constant.ts`,
    text: `import { EXPO_SEND_URL } from '../notifications/push/expo-push-client';
export async function postRaw(messages: unknown[]) {
  return fetch(EXPO_SEND_URL, { method: 'POST', body: JSON.stringify(messages) });
}
`,
    expect: [
      { fn: '<module>', via: 'transport', at: "import { EXPO_SEND_URL }" },
      { fn: 'postRaw', via: 'transport', at: 'fetch(EXPO_SEND_URL' },
    ],
  },
  {
    id: 'new-expo-client',
    from: 'LO-1186 B1 (a)',
    file: `${F}/new-expo-client.ts`,
    text: `import { FetchExpoPushClient } from '../notifications/push/expo-push-client';
export class Blaster {
  async blast() {
    return new FetchExpoPushClient().send([], new AbortController().signal);
  }
}
`,
    expect: [
      { fn: '<module>', via: 'transport', at: 'import { FetchExpoPushClient }' },
      { fn: 'Blaster.blast', via: 'transport', at: 'new FetchExpoPushClient().send(' },
    ],
  },
  {
    id: 'injected-expo-client',
    from: 'LO-1186 B1 (a)',
    file: `${F}/injected-expo-client.ts`,
    text: `import { Inject } from '@nestjs/common';
import { EXPO_PUSH_CLIENT, type ExpoPushClient } from '../notifications/push/push-delivery.service';
export class Injected {
  constructor(@Inject(EXPO_PUSH_CLIENT) private readonly expo: ExpoPushClient) {}
  async go() {
    return this.expo.send([], new AbortController().signal);
  }
}
`,
    expect: [
      { fn: '<module>', via: 'transport', at: 'import { EXPO_PUSH_CLIENT' },
      { fn: 'Injected.go', via: 'transport', at: 'this.expo.send(' },
    ],
  },
  {
    id: 'sdk-reexport',
    from: 'LO-1186 B1 (b)',
    file: `${F}/sdk-reexport.ts`,
    text: `export { Expo as PushSdk } from 'expo-server-sdk';
`,
    expect: [{ fn: '<module>', via: 'transport', at: "export { Expo as PushSdk } from 'expo-server-sdk'" }],
  },
  {
    id: 'client-barrel',
    from: 'LO-1186 B1 (b)',
    file: `${F}/client-barrel.ts`,
    text: `export * from '../notifications/push/expo-push-client';
`,
    expect: [{ fn: '<module>', via: 'transport', at: 'export * from' }],
  },
  {
    id: 'sdk-require',
    from: 'LO-1186 B1 (b)',
    file: `${F}/sdk-require.ts`,
    text: `export function lazySdk() {
  const { Expo } = require('expo-server-sdk');
  return new Expo();
}
`,
    expect: [{ fn: 'lazySdk', via: 'transport', at: "require('expo-server-sdk')" }],
  },
  {
    id: 'sdk-import-equals',
    from: 'LO-1186 B1 (b)',
    file: `${F}/sdk-import-equals.ts`,
    text: `import ExpoSdk = require('expo-server-sdk');
export const sdk = ExpoSdk;
`,
    expect: [{ fn: '<module>', via: 'transport', at: "import ExpoSdk = require('expo-server-sdk')" }],
  },
  {
    id: 'client-dynamic-import',
    from: 'LO-1186 B1 (b)',
    file: `${F}/client-dynamic-import.ts`,
    text: `export async function lateClient() {
  const m = await import('../notifications/push/expo-push-client');
  return m;
}
`,
    expect: [{ fn: 'lateClient', via: 'transport', at: "import('../notifications/push/expo-push-client')" }],
  },
  {
    id: 'outbox-from-module-ref',
    from: 'LO-1186 B1 (c)',
    file: `${F}/outbox-from-module-ref.ts`,
    text: `import type { ModuleRef } from '@nestjs/core';
import { PushDeliveryService } from '../notifications/push/push-delivery.service';
export class Late {
  constructor(private readonly moduleRef: ModuleRef) {}
  async go() {
    await this.moduleRef.get(PushDeliveryService).enqueue({ userId: 'u', kind: 'k', title: '', body: '', data: {}, collapseKey: 'k', timeZone: null });
  }
}
`,
    expect: [{ fn: 'Late.go', via: 'transport', at: '.enqueue(' }],
  },
  {
    id: 'destructured-pushToUser',
    from: 'LO-1186 B1 (b4)',
    file: `${F}/destructured-push-to-user.ts`,
    text: `import type { NotificationsService } from '../notifications/notifications.service';
export class Destructured {
  constructor(private readonly notifications: NotificationsService) {}
  async go() {
    const { pushToUser } = this.notifications;
    await pushToUser.call(this.notifications, 'u', 'title', 'body');
  }
}
`,
    expect: [{ fn: 'Destructured.go', via: 'pushToUser', at: 'const { pushToUser }' }],
  },
  {
    id: 'element-access-sendPush',
    from: 'LO-1186 B1 (b4)',
    file: `${F}/element-access-sendpush.ts`,
    text: `import type { NotificationsService } from '../notifications/notifications.service';
export class Bracketed {
  constructor(private readonly notifications: NotificationsService) {}
  async go() {
    await this.notifications['sendPush']({ user_id: 'u', kind: 'message_received', body: '' });
  }
}
`,
    expect: [{ fn: 'Bracketed.go', via: 'sendPush', at: "this.notifications['sendPush']" }],
  },
  {
    id: 'param-destructured-createNotification',
    from: 'LO-1186 B1 (b4)',
    file: `${F}/param-destructured.ts`,
    text: `import type { NotificationsService } from '../notifications/notifications.service';
export async function writeIt({ createNotification }: NotificationsService) {
  return createNotification({ user_id: 'u', kind: 'coach_alert', body: '' });
}
`,
    expect: [{ fn: 'writeIt', via: 'createNotification', at: '{ createNotification }' }],
  },
  {
    id: 'pick-emitter',
    from: 'FR-1186 search (same class as LS-1186 B1 (b))',
    file: `${F}/pick-emitter.ts`,
    text: `import type { CoachAlertEmitter } from '../notifications/emitters/coach-alert.emitter';
export class Alerts {
  constructor(private readonly alerts: Pick<CoachAlertEmitter, 'emit'>) {}
  async go(args: Parameters<CoachAlertEmitter['emit']>[0]) {
    await this.alerts.emit(args);
  }
}
`,
    expect: [{ fn: 'Alerts.go', via: 'emitter', at: 'this.alerts.emit(' }],
  },
  {
    id: 'pick-community-relay',
    from: 'FR-1186 search (same class as LS-1186 B1 (b))',
    file: `${F}/pick-community-relay.ts`,
    text: `import type { CommunityNotificationsService } from '../community/notifications/community-notifications.service';
export async function relay(svc: Pick<CommunityNotificationsService, 'sendCommunityPush'>, args: Parameters<CommunityNotificationsService['sendCommunityPush']>[0]) {
  await svc.sendCommunityPush(args);
}
`,
    expect: [{ fn: 'relay', via: 'communityPush', at: 'svc.sendCommunityPush(' }],
  },
  // ── FR-1186R2: LO-1186R2 B1 (a relay held under another name) ──────────────────────────────────
  {
    id: 'type-alias-outbox',
    from: 'LO-1186R2 B1',
    file: `${F}/type-alias-outbox.ts`,
    text: `import type { PushDeliveryService } from '../notifications/push/push-delivery.service';
type Outbox = Pick<PushDeliveryService, 'enqueue'>;
export class AliasOutbox {
  constructor(private readonly q: Outbox) {}
  async go() {
    await this.q.enqueue${ENQ};
  }
}
`,
    expect: [{ fn: 'AliasOutbox.go', via: 'transport', at: 'this.q.enqueue(' }],
    finds: [{ at: 'this.q.enqueue(', says: 'calls the push transport directly' }],
  },
  {
    id: 'interface-field-outbox',
    from: 'LO-1186R2 B1',
    file: `${F}/interface-field-outbox.ts`,
    text: `import type { PushDeliveryService } from '../notifications/push/push-delivery.service';
interface NoticeDeps {
  queue: PushDeliveryService;
}
export async function viaDeps(deps: NoticeDeps) {
  await deps.queue.enqueue${ENQ};
}
`,
    expect: [{ fn: 'viaDeps', via: 'transport', at: 'deps.queue.enqueue(' }],
  },
  {
    id: 'type-literal-field-outbox',
    from: 'LO-1186R2 B1',
    file: `${F}/type-literal-field-outbox.ts`,
    text: `import type { PushDeliveryService } from '../notifications/push/push-delivery.service';
export async function viaLiteral(deps: { box: PushDeliveryService }) {
  await deps.box.enqueue${ENQ};
}
`,
    expect: [{ fn: 'viaLiteral', via: 'transport', at: 'deps.box.enqueue(' }],
  },
  {
    id: 'local-alias-outbox',
    from: 'LO-1186R2 B1',
    file: `${F}/local-alias-outbox.ts`,
    text: `import { PushDeliveryService } from '../notifications/push/push-delivery.service';
export class LocalAlias {
  constructor(private readonly outbox: PushDeliveryService) {}
  async go() {
    const q = this.outbox;
    await q.enqueue${ENQ};
  }
}
`,
    expect: [{ fn: 'LocalAlias.go', via: 'transport', at: 'await q.enqueue(' }],
  },
  {
    id: 'destructured-alias-outbox',
    from: 'LO-1186R2 B1 (fresh form, FR-1186R2)',
    file: `${F}/destructured-alias-outbox.ts`,
    text: `import { PushDeliveryService } from '../notifications/push/push-delivery.service';
export class Destructured {
  constructor(private readonly outbox: PushDeliveryService) {}
  async go() {
    const { outbox: box } = this;
    await box.enqueue${ENQ};
  }
}
`,
    expect: [{ fn: 'Destructured.go', via: 'transport', at: 'await box.enqueue(' }],
  },
  {
    id: 'inject-token-outbox',
    from: 'LO-1186R2 B1',
    file: `${F}/inject-token-outbox.ts`,
    text: `import { Inject } from '@nestjs/common';
import { PushDeliveryService } from '../notifications/push/push-delivery.service';
export class Injected {
  constructor(@Inject(PushDeliveryService) private readonly sink: { enqueue(x: unknown): Promise<unknown> }) {}
  async go() {
    await this.sink.enqueue${ENQ};
  }
}
`,
    expect: [{ fn: 'Injected.go', via: 'transport', at: 'this.sink.enqueue(' }],
  },
  {
    id: 'outbox-import-backstop',
    from: 'LO-1186R2 B1 (the import backstop, FR-1186R2)',
    file: `${F}/outbox-import-backstop.ts`,
    text: `import { PushDeliveryService } from '../notifications/push/push-delivery.service';
export const OUTBOX_TOKEN = PushDeliveryService;
export async function viaAny(x: any) {
  await x.enqueue({});
}
`,
    expect: [{ fn: '<module>', via: 'transport', at: 'import { PushDeliveryService }' }],
    finds: [{ at: 'import { PushDeliveryService }', says: 'calls the push transport directly' }],
  },
  {
    id: 'type-alias-emitter',
    from: 'LO-1186R2 B1',
    file: `${F}/type-alias-emitter.ts`,
    text: `import type { CoachAlertEmitter } from '../notifications/emitters/coach-alert.emitter';
type Alerts = CoachAlertEmitter;
export class Watcher {
  constructor(private readonly a: Alerts) {}
  async go() {
    await this.a.emit({ coachId: 'c', alertId: 'a', alertType: 't', message: 'm', severity: 'warning' });
  }
}
`,
    expect: [{ fn: 'Watcher.go', via: 'emitter', at: 'this.a.emit(' }],
    finds: [{ at: 'this.a.emit(', says: 'not in the sender registry' }],
  },
  {
    id: 'interface-extends-emitter',
    from: 'LO-1186R2 B1 (fresh form, FR-1186R2)',
    file: `${F}/interface-extends-emitter.ts`,
    text: `import type { CoachAlertEmitter } from '../notifications/emitters/coach-alert.emitter';
interface Alerter extends CoachAlertEmitter {}
export async function alertVia(x: Alerter) {
  await x.emit({ coachId: 'c', alertId: 'a', alertType: 't', message: 'm', severity: 'warning' });
}
`,
    expect: [{ fn: 'alertVia', via: 'emitter', at: 'x.emit(' }],
  },
  {
    id: 'local-alias-emitter',
    from: 'LO-1186R2 B1 (fresh form, FR-1186R2)',
    file: `${F}/local-alias-emitter.ts`,
    text: `import { CoachAlertEmitter } from '../notifications/emitters/coach-alert.emitter';
export class Copy {
  constructor(private readonly coachAlert: CoachAlertEmitter) {}
  async go() {
    const tell = this.coachAlert;
    await tell.emit({ coachId: 'c', alertId: 'a', alertType: 't', message: 'm', severity: 'warning' });
  }
}
`,
    expect: [{ fn: 'Copy.go', via: 'emitter', at: 'await tell.emit(' }],
  },
  {
    id: 'type-alias-community',
    from: 'LO-1186R2 B1',
    file: `${F}/type-alias-community.ts`,
    text: `import type { CommunityNotificationsService } from '../community/notifications/community-notifications.service';
type Relay = Pick<CommunityNotificationsService, 'sendCommunityPush'>;
export async function relayVia(r: Relay) {
  await r.sendCommunityPush({});
}
`,
    expect: [{ fn: 'relayVia', via: 'communityPush', at: 'r.sendCommunityPush(' }],
  },
  // ── FR-1186R2: LS-1186R2 B1 (a kind the guard must read as its value) ───────────────────────────
  {
    id: 'kind-string-literal',
    from: 'LS-1186R2 B1',
    file: WB,
    text: wb('', `'first_payment'`),
    expect: [{ fn: 'WorkoutBuilderService.emitAssignmentPush', via: 'sendPush', at: 'notifications.sendPush(' }],
    finds: [{ at: 'notifications.sendPush(', says: 'passes kind first_payment' }],
  },
  {
    id: 'kind-template-literal',
    from: 'LS-1186R2 B1',
    file: WB,
    text: wb('', '`first_payment`'),
    expect: [{ fn: 'WorkoutBuilderService.emitAssignmentPush', via: 'sendPush', at: 'notifications.sendPush(' }],
    finds: [{ at: 'notifications.sendPush(', says: 'passes kind first_payment' }],
  },
  {
    id: 'kind-element-access',
    from: 'LS-1186R2 B1',
    file: WB,
    text: wb('', `NotificationKind['FIRST_PAYMENT']`),
    expect: [{ fn: 'WorkoutBuilderService.emitAssignmentPush', via: 'sendPush', at: 'notifications.sendPush(' }],
    finds: [{ at: 'notifications.sendPush(', says: 'passes kind first_payment' }],
  },
  {
    id: 'kind-const',
    from: 'LS-1186R2 B1 (fresh form, FR-1186R2)',
    file: WB,
    text: wb(`const KIND = 'first_payment' as const;`, 'KIND'),
    expect: [{ fn: 'WorkoutBuilderService.emitAssignmentPush', via: 'sendPush', at: 'notifications.sendPush(' }],
    finds: [{ at: 'notifications.sendPush(', says: 'passes kind first_payment' }],
  },
  {
    id: 'kind-not-a-kind',
    from: 'LS-1186R2 B1',
    file: WB,
    text: wb('', `'not_a_kind'`),
    expect: [{ fn: 'WorkoutBuilderService.emitAssignmentPush', via: 'sendPush', at: 'notifications.sendPush(' }],
    finds: [{ at: 'notifications.sendPush(', says: "passes 'not_a_kind', which is not a NotificationKind" }],
  },
  {
    id: 'kind-unreadable',
    from: 'LS-1186R2 B1',
    file: WB,
    text: wb('', 'pick()'),
    expect: [{ fn: 'WorkoutBuilderService.emitAssignmentPush', via: 'sendPush', at: 'notifications.sendPush(' }],
    finds: [{ at: 'notifications.sendPush(', says: 'passes a kind the scan cannot read (pick())' }],
  },
  // ── FR-1186R2: LO-1186R2 B2 (a context the guard must read as its value) ────────────────────────
  {
    id: 'context-renewal-offer',
    from: 'LO-1186R2 B2',
    file: WB,
    text: wb(`import { RENEWAL_OFFER } from '../notifications/push/push-preferences';`, 'NotificationKind.WORKOUT_ASSIGNED', ', context: RENEWAL_OFFER'),
    expect: [{ fn: 'WorkoutBuilderService.emitAssignmentPush', via: 'sendPush', at: 'notifications.sendPush(' }],
    finds: [{ at: 'notifications.sendPush(', says: 'passes a renewal offer context (RENEWAL_OFFER), but no funnel entry declares one' }],
  },
  {
    id: 'context-renewal-offer-aliased',
    from: 'LO-1186R2 B2 (fresh form, FR-1186R2)',
    file: WB,
    text: wb(`import { RENEWAL_OFFER as OFFER } from '../notifications/push/push-preferences';`, 'NotificationKind.WORKOUT_ASSIGNED', ', context: OFFER'),
    expect: [{ fn: 'WorkoutBuilderService.emitAssignmentPush', via: 'sendPush', at: 'notifications.sendPush(' }],
    finds: [{ at: 'notifications.sendPush(', says: 'passes a renewal offer context (RENEWAL_OFFER), but no funnel entry declares one' }],
  },
  {
    id: 'context-mute-all-pass-aliased',
    from: 'LO-1186R2 B2 (fresh form, FR-1186R2)',
    file: WB,
    text: wb(`import { MUTE_ALL_PASS as PASS } from '../notifications/push/push-preferences';`, 'NotificationKind.WORKOUT_ASSIGNED', ', context: PASS'),
    expect: [{ fn: 'WorkoutBuilderService.emitAssignmentPush', via: 'sendPush', at: 'notifications.sendPush(' }],
    finds: [{ at: 'notifications.sendPush(', says: 'passes a context that can pass Mute all (passesMuteAll' }],
  },
  {
    id: 'context-unreadable',
    from: 'LO-1186R2 B2 / C3',
    file: WB,
    text: wb('', 'NotificationKind.WORKOUT_ASSIGNED', ', context: ctx'),
    expect: [{ fn: 'WorkoutBuilderService.emitAssignmentPush', via: 'sendPush', at: 'notifications.sendPush(' }],
    finds: [{ at: 'notifications.sendPush(', says: 'passes a context the scan cannot read;' }],
  },
  {
    id: 'kind-enum-control',
    from: 'control (FR-1186R2: the registered send as written, nothing to report)',
    file: WB,
    text: wb('', 'NotificationKind.WORKOUT_ASSIGNED'),
    expect: [{ fn: 'WorkoutBuilderService.emitAssignmentPush', via: 'sendPush', at: 'notifications.sendPush(' }],
    finds: [],
  },
  {
    id: 'kind-string-control',
    from: 'control (FR-1186R2: a string literal of the row\'s own kind, nothing to report)',
    file: WB,
    text: wb('', `'workout_assigned'`),
    expect: [{ fn: 'WorkoutBuilderService.emitAssignmentPush', via: 'sendPush', at: 'notifications.sendPush(' }],
    finds: [],
  },
  // ── Controls: forms the scan saw before FR-1186 ─────────────────────────────────────────────
  {
    id: 'direct-sendPush',
    from: 'control',
    file: `${F}/direct-sendpush.ts`,
    text: `import type { NotificationsService } from '../notifications/notifications.service';
export class Direct {
  constructor(private readonly notifications: NotificationsService) {}
  async go() {
    await this.notifications.sendPush({ user_id: 'u', kind: 'message_received', body: '' });
  }
}
`,
    expect: [{ fn: 'Direct.go', via: 'sendPush', at: 'this.notifications.sendPush(' }],
  },
  {
    id: 'sdk-import',
    from: 'control',
    file: `${F}/sdk-import.ts`,
    text: `import { Expo } from 'expo-server-sdk';
export async function sdkSend() {
  return new Expo().sendPushNotificationsAsync([]);
}
`,
    expect: [
      { fn: '<module>', via: 'transport', at: "import { Expo } from 'expo-server-sdk'" },
      { fn: 'sdkSend', via: 'transport', at: 'sendPushNotificationsAsync' },
    ],
  },
  {
    id: 'expo-url-literal',
    from: 'control',
    file: `${F}/expo-url-literal.ts`,
    text: `export function rawHttp() {
  return fetch('https://exp.host/--/api/v2/push/send', { method: 'POST', body: '[]' });
}
`,
    expect: [{ fn: 'rawHttp', via: 'transport', at: 'https://exp.host' }],
  },
  {
    id: 'push-named-enqueue',
    from: 'control',
    file: `${F}/push-named-enqueue.ts`,
    text: `export async function viaName(pushDelivery: { enqueue(x: unknown): Promise<unknown> }) {
  return pushDelivery.enqueue({});
}
`,
    expect: [{ fn: 'viaName', via: 'transport', at: 'pushDelivery.enqueue(' }],
  },
  // ── Negatives: must report nothing ────────────────────────────────────────────────────────────
  {
    id: 'other-queue-enqueue',
    from: 'negative',
    file: `${F}/other-queue.ts`,
    text: `interface JobQueue { enqueue(job: string): Promise<void> }
export async function schedule(jobs: JobQueue) {
  await jobs.enqueue('nightly');
}
`,
    expect: [],
  },
  {
    id: 'outbox-type-only',
    from: 'negative',
    file: `${F}/outbox-type-only.ts`,
    text: `import type { EnqueueResult } from '../notifications/push/push-delivery.service';
export const done = (r: EnqueueResult): boolean => r !== null;
`,
    expect: [],
  },
  {
    id: 'other-send',
    from: 'negative',
    file: `${F}/other-send.ts`,
    text: `export async function mail(mailer: { send(to: string): Promise<void> }) {
  await mailer.send('a');
}
`,
    expect: [],
  },
  {
    id: 'spec-file',
    from: 'negative (tests are never runtime)',
    file: `${F}/thing.spec.ts`,
    text: `export const x = (n: { sendPush(a: unknown): void }) => n.sendPush({});
`,
    expect: [],
  },
];

/** LS-1186 B-TEST (btest/LS-1186-sender-guard-bites @ 785cb13a, test/ls-1186-aliased-senders.spec.ts): its fixture, as written there. */
export const LS_1186_FIXTURE_REL = 'src/ls1186-notify-probe.ts';
export const LS_1186_FIXTURE = `
import type { NotificationsService } from './notifications/notifications.service';
import type { PushDeliveryService } from './notifications/push/push-delivery.service';
import { NotificationKind } from './notifications/notification-kind';
import { FetchExpoPushClient as RawPushClient } from './notifications/push/expo-push-client';
export function aliasedSender(notices: Pick<NotificationsService, 'sendPush'>) {
  const deliver = notices.sendPush.bind(notices);
  return deliver({ user_id: 'ls1186-recipient', kind: NotificationKind.MESSAGE_RECEIVED, body: '' });
}
export function aliasedTransport(delivery: Pick<PushDeliveryService, 'enqueue'>) {
  return delivery.enqueue({
    userId: 'ls1186-recipient', kind: 'message_received', title: '', body: '',
    data: {}, collapseKey: 'ls1186', timeZone: 'America/New_York',
  });
}
export function rawImportedTransport(client: RawPushClient) {
  return client.send(
    [{ to: 'ExponentPushToken[ls1186probe00000000001]', body: 'Probe' }],
    new AbortController().signal,
  );
}
`;

/**
 * LO-1186 B2 bite: WorkoutBuilderService.emitAssignmentPush (src/workout-builder/workout-builder.service.ts)
 * changed to pass `urgent: true` and a Mute all pass. Its registry row still declares a plain
 * workout_assigned push, so the funnel check must go red and name this file and line.
 */
export const LO_1186_B2_FILE = 'src/workout-builder/workout-builder.service.ts';
export const LO_1186_B2_TEXT = `import { NotificationKind } from '../notifications/notification-kind';
import type { NotificationsService } from '../notifications/notifications.service';
export class WorkoutBuilderService {
  private emitAssignmentPush(notifications: NotificationsService, clientId: string, body: string, deepLink: string) {
    void Promise.resolve()
      .then(() => notifications.sendPush({ user_id: clientId, kind: NotificationKind.WORKOUT_ASSIGNED, body, deep_link: deepLink, urgent: true, context: { passesMuteAll: true } }))
      .catch((err: unknown) => console.warn(err));
  }
}
`;
