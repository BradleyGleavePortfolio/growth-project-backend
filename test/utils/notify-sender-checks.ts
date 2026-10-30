import { NotificationKind, type NotificationKindValue } from '../../src/notifications/notification-kind';
import { SAFETY_ALERT_PUSH_BODY } from '../../src/notifications/push/lock-screen-copy';
import { FUNNEL_SITES, SENDERS, type FunnelPush, type FunnelSite, type SenderRow } from './notify-sender-registry';
import type { SendHit } from './notify-sender-scan';

/**
 * The KT-4 checks over a scan (test/utils/notify-sender-scan.ts), shared by the sender registry spec and the
 * scan's own self-test (src/notifications/__tests__/sender-scan-forms.spec.ts), so the self-test proves the
 * same check the registry spec runs. Each returns one message per problem; an empty list is green.
 */
export const KT4 = 'KT-4 (KNOWN_TRAPS.md; read the header of src/notifications/__tests__/sender-registry.spec.ts)';
export const keyOf = (file: string, fn: string): string => `${file}#${fn}`;
export const where = (h: SendHit): string => `${h.file}:${h.line} ${h.fn} [${h.via}] ${h.code}`;

/** What the scan reads from a sendPush call (PushArgs in notify-sender-scan.ts). */
export interface ArgsSeen {
  opaque: boolean;
  variants: Array<{
    kindMember: string | null;
    kindCode: string;
    urgent: 'absent' | 'true' | 'false' | 'dynamic';
    context: 'absent' | 'plain' | 'passes' | 'dynamic';
    contextValue?: Record<string, unknown> | null;
  }>;
}
type Hit = SendHit & { args?: ArgsSeen };

const funnelKeys = (funnel: FunnelSite[]): Set<string> => new Set(funnel.map((s) => keyOf(s.file, s.fn)));

/** "calls the push transport directly": a transport hit in a function that is not a FUNNEL_SITES row. */
export function directTransport(hits: SendHit[], funnel: FunnelSite[] = FUNNEL_SITES): string[] {
  const f = funnelKeys(funnel);
  return hits
    .filter((h) => h.via === 'transport' && !f.has(keyOf(h.file, h.fn)))
    .map((h) => `calls the push transport directly, outside the funnel. ${KT4}: ${where(h)}`);
}

/** "not in the sender registry": a send hit whose function has no SENDERS row with that via. */
export function unregistered(hits: SendHit[], senders: SenderRow[] = SENDERS, funnel: FunnelSite[] = FUNNEL_SITES): string[] {
  const f = funnelKeys(funnel);
  const rows = new Map(senders.map((r) => [keyOf(r.file, r.fn), r]));
  return hits
    .filter((h) => {
      if (h.via === 'transport') return false; // directTransport
      if (f.has(keyOf(h.file, h.fn))) return false;
      const row = rows.get(keyOf(h.file, h.fn));
      return !row || !row.via.includes(h.via);
    })
    .map((h) => `not in the sender registry (test/utils/notify-sender-registry.ts). ${KT4}: ${where(h)}`);
}

/** A funnel push whose context passes Mute all: MUTE_ALL_PASS, or a safety alert key (owner #168-18). */
export const contextPasses = (c: FunnelPush['context']): boolean =>
  !!c && (c.passesMuteAll === true || (typeof c.safetyAlert === 'string' && c.safetyAlert in SAFETY_ALERT_PUSH_BODY));

const kindOf = (member: string): NotificationKindValue | undefined => (NotificationKind as Record<string, NotificationKindValue>)[member];

/** The sendPush hits of each registered sender (the funnel's own sendPush calls are left out). */
export function sendPushHitsByRow(hits: SendHit[], senders: SenderRow[] = SENDERS, funnel: FunnelSite[] = FUNNEL_SITES): Map<SenderRow, Hit[]> {
  const f = funnelKeys(funnel);
  const out = new Map<SenderRow, Hit[]>();
  for (const r of senders) {
    const hs = hits.filter((h) => h.via === 'sendPush' && h.file === r.file && h.fn === r.fn && !f.has(keyOf(h.file, h.fn)));
    if (hs.length > 0) out.set(r, hs as Hit[]);
  }
  return out;
}

/**
 * LO-1186 B2: each sendPush sender's `funnel` entries must declare what its code passes. The scan reads every
 * sendPush call's argument (kind, urgent, context; one variant per branch of a conditional spread). Red when:
 * the code passes a kind, `urgent`, or a Mute all pass (passesMuteAll, MUTE_ALL_PASS, safetyAlert, or a
 * context the scan cannot read) that no funnel entry declares; when an entry declares one the code never
 * passes; or when the scan cannot read the argument at all.
 */
export function funnelArgFindings(hits: SendHit[], senders: SenderRow[] = SENDERS, funnel: FunnelSite[] = FUNNEL_SITES): string[] {
  const out: string[] = [];
  for (const [row, hs] of sendPushHitsByRow(hits, senders, funnel)) {
    const say = (h: Hit, what: string): void => {
      out.push(`${h.file}:${h.line} ${row.fn}: ${what}. Fix the row's funnel entries in test/utils/notify-sender-registry.ts (or the sender). ${KT4}`);
    };
    const opaque = hs.filter((h) => !h.args || h.args.opaque);
    for (const h of opaque) {
      say(h, 'the scan cannot read what this sendPush passes (kind, urgent, context); call sendPush with an object literal so the funnel table sends the same values');
    }
    if (opaque.length > 0) continue;
    const entries = row.funnel ?? [];
    if (entries.length === 0) {
      say(hs[0], 'queues a push through sendPush, but its registry row has no funnel entries for the funnel table to send');
      continue;
    }
    const vs = hs.flatMap((h) => (h.args as ArgsSeen).variants.map((v) => ({ h, v })));
    // kind
    const staticKinds = vs.every(({ v }) => v.kindMember !== null);
    for (const { h, v } of vs) {
      if (v.kindMember === null) continue;
      const k = kindOf(v.kindMember);
      if (!k) say(h, `passes ${v.kindCode}, which is not a NotificationKind`);
      else if (!entries.some((e) => e.kind === k)) say(h, `passes kind ${k}, which no funnel entry declares`);
    }
    const codeKinds = new Set(vs.map(({ v }) => (v.kindMember ? kindOf(v.kindMember) : undefined)));
    for (const e of entries) {
      if (staticKinds && !codeKinds.has(e.kind)) say(hs[0], `a funnel entry declares kind ${e.kind}, which the code never passes`);
      if (!staticKinds && !row.kinds.includes(e.kind)) say(hs[0], `a funnel entry declares kind ${e.kind}, which is not in the row's kinds`);
    }
    // urgent
    const urgentAt = vs.find(({ v }) => v.urgent === 'true' || v.urgent === 'dynamic');
    const plainAt = vs.find(({ v }) => v.urgent !== 'true');
    if (urgentAt && !entries.some((e) => e.urgent === true)) say(urgentAt.h, 'passes urgent, but no funnel entry declares urgent: true');
    if (!urgentAt && entries.some((e) => e.urgent === true)) say(hs[0], 'a funnel entry declares urgent: true, but the code never passes urgent');
    if (plainAt && !entries.some((e) => e.urgent !== true)) say(plainAt.h, 'can send without urgent, but every funnel entry is urgent');
    if (!plainAt && entries.some((e) => e.urgent !== true)) say(hs[0], 'always passes urgent: true, but a funnel entry is not urgent');
    // context: a Mute all pass
    const passAt = vs.find(({ v }) => v.context === 'passes' || v.context === 'dynamic');
    const noPassAt = vs.find(({ v }) => v.context !== 'passes');
    if (passAt && !entries.some((e) => contextPasses(e.context))) {
      say(passAt.h, `passes a context that can pass Mute all (${passAt.v.context === 'passes' ? 'passesMuteAll, MUTE_ALL_PASS or safetyAlert' : 'a value the scan cannot read'}), but no funnel entry declares one`);
    }
    if (!passAt && entries.some((e) => contextPasses(e.context))) say(hs[0], 'a funnel entry declares a Mute all pass, but the code never passes one');
    if (noPassAt && !entries.some((e) => !contextPasses(e.context))) say(noPassAt.h, 'can send without a Mute all pass, but every funnel entry passes Mute all');
    if (!noPassAt && entries.some((e) => !contextPasses(e.context))) say(hs[0], 'always passes a Mute all pass, but a funnel entry does not');
  }
  return out;
}

/**
 * What the funnel table sends for one funnel entry: the values the sender's own code passes wherever the scan
 * can read one value for all its sendPush calls (kind, urgent, context), and the entry's declared value only
 * where the code picks at run time (funnelArgFindings has checked that the entries cover each choice).
 */
export function sentValues(
  hs: readonly SendHit[] | undefined,
  e: FunnelPush,
): { kind: NotificationKindValue; urgent: boolean | undefined; context: FunnelPush['context']; from: string } {
  const vs = (hs ?? []).flatMap((h) => {
    const a = (h as Hit).args;
    return a && !a.opaque ? a.variants : [];
  });
  if (vs.length === 0) return { kind: e.kind, urgent: e.urgent, context: e.context ?? null, from: 'registry (no sendPush call of its own: the emitter it calls sends)' };
  const from: string[] = [];
  const members = new Set(vs.map((v) => v.kindMember));
  const one = members.size === 1 ? [...members][0] : null;
  const kind = one && kindOf(one) ? (kindOf(one) as NotificationKindValue) : e.kind;
  from.push(one && kindOf(one) ? 'kind: code' : 'kind: registry');
  const us = new Set(vs.map((v) => v.urgent));
  let urgent = e.urgent;
  if (us.size === 1 && !us.has('dynamic')) {
    urgent = us.has('true') ? true : us.has('false') ? false : undefined;
    from.push('urgent: code');
  } else from.push('urgent: registry');
  const cs = vs.map((v) => (v.context === 'absent' ? 'null' : v.contextValue === undefined ? undefined : JSON.stringify(v.contextValue)));
  let context = e.context ?? null;
  if (cs.every((c) => c !== undefined && c === cs[0])) {
    context = JSON.parse(cs[0] as string) as FunnelPush['context'];
    from.push('context: code');
  } else from.push('context: registry');
  return { kind, urgent, context, from: from.join(', ') };
}
