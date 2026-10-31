import { NotificationKind, type NotificationKindValue } from '../../src/notifications/notification-kind';
import { SAFETY_ALERT_PUSH_BODY } from '../../src/notifications/push/lock-screen-copy';
import { FUNNEL_SITES, IMPORTS_WITHOUT_SEND, SENDERS, type FunnelPush, type FunnelSite, type ImportWithoutSend, type SenderRow } from './notify-sender-registry';
import type { PushArgs, SendHit } from './notify-sender-scan';

/**
 * The KT-4 checks over a scan (test/utils/notify-sender-scan.ts), shared by the sender registry spec and the
 * scan's own self-test (src/notifications/__tests__/sender-scan-forms.spec.ts), so the self-test proves the
 * same check the registry spec runs. Each returns one message per problem; an empty list is green.
 */
export const KT4 = 'KT-4 (KNOWN_TRAPS.md; read the header of src/notifications/__tests__/sender-registry.spec.ts)';
export const keyOf = (file: string, fn: string): string => `${file}#${fn}`;
export const where = (h: SendHit): string => `${h.file}:${h.line} ${h.fn} [${h.via}] ${h.code}`;

/** What the scan reads from a sendPush call (PushArgs in notify-sender-scan.ts). */
export type ArgsSeen = PushArgs;
type Hit = SendHit;

const funnelKeys = (funnel: FunnelSite[]): Set<string> => new Set(funnel.map((s) => keyOf(s.file, s.fn)));

/** "calls the push transport directly": a transport hit in a function that is not a FUNNEL_SITES row. */
export function directTransport(hits: SendHit[], funnel: FunnelSite[] = FUNNEL_SITES): string[] {
  const f = funnelKeys(funnel);
  return hits
    .filter((h) => h.via === 'transport' && !f.has(keyOf(h.file, h.fn)))
    .map((h) => `calls the push transport directly, outside the funnel. ${KT4}: ${where(h)}`);
}

/** "not in the sender registry": a send hit whose function has no SENDERS row with that via. */
export function unregistered(
  hits: SendHit[],
  senders: SenderRow[] = SENDERS,
  funnel: FunnelSite[] = FUNNEL_SITES,
  noSend: ImportWithoutSend[] = IMPORTS_WITHOUT_SEND,
): string[] {
  const f = funnelKeys(funnel);
  const rows = new Map(senders.map((r) => [keyOf(r.file, r.fn), r]));
  return hits.flatMap((h) => {
    if (h.via === 'transport') return []; // directTransport
    // FR-1186R3: fail closed. Only IMPORTS_WITHOUT_SEND clears an import the scan reads no send of; a sender row or
    // a funnel site never does.
    if (h.via === 'unread') return noSend.some((e) => isListed(e, h)) ? [] : [unreadMessage(h)];
    if (f.has(keyOf(h.file, h.fn))) return [];
    const row = rows.get(keyOf(h.file, h.fn));
    return !row || !row.via.includes(h.via) ? [`not in the sender registry (test/utils/notify-sender-registry.ts). ${KT4}: ${where(h)}`] : [];
  });
}

const isListed = (e: ImportWithoutSend, h: SendHit): boolean => e.file === h.file && e.name === h.unread?.name;

const unreadMessage = (h: SendHit): string =>
  `the scan reads no send of ${h.unread?.name ?? '?'} in this file, though it imports it (${h.unread?.form ?? '?'}). ` +
  'KT-4 fails closed: write the send in a form the scan reads (SEND_FORMS in test/utils/notify-sender-forms.ts lists them) ' +
  'and register it, or, if this file only holds the class and never sends through it, add it to IMPORTS_WITHOUT_SEND ' +
  `in test/utils/notify-sender-registry.ts with why. ${KT4}: ${where(h)}`;

/** FR-1186R3: an IMPORTS_WITHOUT_SEND entry the scan no longer needs (the file now sends, or no longer imports it). */
export function staleImportsWithoutSend(hits: SendHit[], noSend: ImportWithoutSend[] = IMPORTS_WITHOUT_SEND): string[] {
  return noSend
    .filter((e) => !hits.some((h) => h.via === 'unread' && isListed(e, h)))
    .map((e) => `IMPORTS_WITHOUT_SEND lists ${e.file} ${e.name}, but the scan reads a send of it there or no import of it: delete the entry. ${KT4}`);
}

/** A funnel push whose context passes Mute all: MUTE_ALL_PASS, or a safety alert key (owner #168-18). */
export const contextPasses = (c: FunnelPush['context']): boolean =>
  !!c && (c.passesMuteAll === true || (typeof c.safetyAlert === 'string' && c.safetyAlert in SAFETY_ALERT_PUSH_BODY));

const KIND_VALUES = new Set<string>(Object.values(NotificationKind));
const isKind = (v: string | null): v is NotificationKindValue => v !== null && KIND_VALUES.has(v);
/** A funnel push whose context is a renewal offer (RENEWAL_OFFER): Mute all stops it and it needs the person's yes. */
export const contextOffers = (c: FunnelPush['context']): boolean => !!c && (c as { renewalOffer?: unknown }).renewalOffer === true;

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
 * the code passes a kind, `urgent`, a Mute all pass (passesMuteAll, MUTE_ALL_PASS, safetyAlert) or a renewal
 * offer (RENEWAL_OFFER) that no funnel entry declares; when an entry declares one the code never passes; or
 * when the scan cannot read the argument at all.
 * FR-1186R2 (LS-1186R2 B1): a kind spelled statically (`NotificationKind.X`, `NotificationKind['X']`, a string
 * or template literal, a const of one) is checked as that value; any other kind is red unless the row declares
 * that exact code as its `dynamicKind`. FR-1186R2 (LO-1186R2 B2): a context the scan cannot read is red; it is
 * no longer taken as "can pass Mute all".
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
    const staticKinds = vs.every(({ v }) => v.kindStatic);
    for (const { h, v } of vs) {
      if (!v.kindStatic) {
        if (row.dynamicKind?.code !== v.kindCode) {
          say(h, `passes a kind the scan cannot read (${v.kindCode}); spell it NotificationKind.X or a string literal, or declare dynamicKind: { code: '${v.kindCode}' } on the row with a funnel entry for each kind it can be`);
        }
        continue;
      }
      if (!isKind(v.kindValue)) say(h, `passes ${v.kindCode}, which is not a NotificationKind`);
      else if (!entries.some((e) => e.kind === v.kindValue)) say(h, `passes kind ${v.kindValue} (${v.kindCode}), which no funnel entry declares`);
    }
    const codeKinds = new Set(vs.map(({ v }) => (v.kindStatic ? v.kindValue : undefined)));
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
    // context: a value the scan cannot read is red (FR-1186R2, LO-1186R2 B2: RENEWAL_OFFER is read as its value)
    for (const { h } of vs.filter(({ v }) => v.context === 'dynamic')) {
      say(h, 'passes a context the scan cannot read; write it as an object literal or a push-preferences constant (MUTE_ALL_PASS, RENEWAL_OFFER) so the funnel table sends the same value');
    }
    // context: a renewal offer (Mute all stops it; it needs the person's yes)
    const offerAt = vs.find(({ v }) => v.context === 'offer');
    if (offerAt && !entries.some((e) => contextOffers(e.context))) say(offerAt.h, 'passes a renewal offer context (RENEWAL_OFFER), but no funnel entry declares one');
    if (!offerAt && entries.some((e) => contextOffers(e.context))) say(hs[0], 'a funnel entry declares a renewal offer context, but the code never passes one');
    const noOfferAt = vs.find(({ v }) => v.context !== 'offer');
    if (noOfferAt && !entries.some((e) => !contextOffers(e.context))) say(noOfferAt.h, 'can send without a renewal offer context, but every funnel entry is an offer');
    // context: a Mute all pass
    const passAt = vs.find(({ v }) => v.context === 'passes');
    const noPassAt = vs.find(({ v }) => v.context !== 'passes');
    if (passAt && !entries.some((e) => contextPasses(e.context))) {
      say(passAt.h, 'passes a context that can pass Mute all (passesMuteAll, MUTE_ALL_PASS or safetyAlert), but no funnel entry declares one');
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
  // FR-1186R2 (LS-1186R2 B1): the kind the code spells, whatever the spelling; the registry's only when the code picks it at run time.
  const values = new Set(vs.map((v) => (v.kindStatic ? v.kindValue : null)));
  const one = values.size === 1 ? [...values][0] : null;
  const kind = one !== null ? (one as NotificationKindValue) : e.kind;
  from.push(one !== null ? 'kind: code' : 'kind: registry');
  const us = new Set(vs.map((v) => v.urgent));
  let urgent = e.urgent;
  if (us.size === 1 && !us.has('dynamic')) {
    urgent = us.has('true') ? true : us.has('false') ? false : undefined;
    from.push('urgent: code');
  } else from.push('urgent: registry');
  const cs = vs.map((v) => (v.context === 'absent' ? 'null' : v.contextValue === undefined ? undefined : JSON.stringify(v.contextValue)));
  let context: FunnelPush['context'] = e.context ?? null;
  if (cs.every((c) => c !== undefined && c === cs[0])) {
    context = JSON.parse(cs[0] as string) as FunnelPush['context'];
    from.push('context: code');
  } else from.push('context: registry');
  return { kind, urgent, context, from: from.join(', ') };
}
