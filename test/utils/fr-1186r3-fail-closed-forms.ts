/**
 * FR-1186R3 (b#1186 fix round 3): new senders the KT-4 walker cannot read, each reached only through an import
 * form whose names it does not follow (a dynamic import, require, `import x = require`, a namespace import, an
 * inline `typeof import()` type) or a method name built at run time. Before FR-1186R3 the scan reported nothing for
 * any of them. The gate must now be red on each with the file and the line in `at` (the import, or the send).
 * Written as text only: the spec reads it through the real scan, never runs it.
 */
export const FAIL_CLOSED_FILE = 'src/coach/fr-r3-fail-closed.service.ts';
const ALERT = `{ coachId: 'c', alertId: 'a', alertType: 'kt4_fail_closed', message: 'm', severity: 'warning', money: true }`;

export interface FailClosedForm {
  id: string;
  text: string;
  /** A piece of the line the finding must name. */
  at: string;
}

export const FAIL_CLOSED_FORMS: FailClosedForm[] = [
  {
    id: 'an emitter loaded by a dynamic import and called in its callback',
    text: `export class Nightly {
  async notify(svc: unknown): Promise<void> {
    await import('../notifications/emitters/coach-alert.emitter').then((m) => new m.CoachAlertEmitter(svc).emit(${ALERT}));
  }
}
`,
    at: "import('../notifications/emitters/coach-alert.emitter')",
  },
  {
    id: 'an emitter taken from require() under another name',
    text: `export class Nightly {
  async notify(svc: unknown): Promise<void> {
    const { CoachAlertEmitter: Alerts } = require('../notifications/emitters/coach-alert.emitter');
    await new Alerts(svc).emit(${ALERT});
  }
}
`,
    at: "require('../notifications/emitters/coach-alert.emitter')",
  },
  {
    id: 'an emitter typed through a namespace import',
    text: `import * as alerts from '../notifications/emitters/coach-alert.emitter';
export class Nightly {
  constructor(private readonly a: alerts.CoachAlertEmitter) {}
  async notify(): Promise<void> {
    await this.a.emit(${ALERT});
  }
}
`,
    at: 'import * as alerts',
  },
  {
    id: 'the community relay typed through import = require',
    text: `import community = require('../community/notifications/community-notifications.service');
export class Nightly {
  constructor(private readonly c: community.CommunityNotificationsService) {}
  async notify(): Promise<void> {
    await this.c.sendCommunityPush({ recipientId: 'u', kind: 'community_dm_received', targetType: 'dm', targetId: 'd' });
  }
}
`,
    at: 'import community = require(',
  },
  {
    id: 'the notice writer (NotificationsService) called by a method name built at run time',
    text: `import type { NotificationsService } from '../notifications/notifications.service';
export class Nightly {
  constructor(private readonly notices: NotificationsService) {}
  async notify(how: string): Promise<void> {
    const name = (how + 'Notification') as 'createNotification';
    await this.notices[name]({ user_id: 'u', kind: 'coach_alert', body: 'b' });
  }
}
`,
    at: 'import type { NotificationsService }',
  },
  {
    id: 'the push transport typed by typeof import()',
    text: `export async function wire(client: InstanceType<typeof import('../notifications/push/expo-push-client').FetchExpoPushClient>, messages: never[]) {
  return client.send(messages, new AbortController().signal);
}
`,
    at: 'export async function wire(',
  },
];

/** Control: the same emitter send in the form the walker reads (a named import, a typed constructor field). */
export const READ_FORM_TEXT = `import { CoachAlertEmitter } from '../notifications/emitters/coach-alert.emitter';
export class Nightly {
  constructor(private readonly alerts: CoachAlertEmitter) {}
  async notify(): Promise<void> {
    await this.alerts.emit(${ALERT});
  }
}
`;
