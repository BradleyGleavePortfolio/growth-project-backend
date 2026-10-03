// src/coach/brief/roman/roman-highlights.ts
//
// A5-COACH-BRIEF — the deterministic Roman layer of the coach daily brief.
//
// Pure functions only (no I/O): the service gathers rows, these functions
// reconcile money and compose the butler-tone lines. Nothing here calls a
// model, so no client data leaves the server through this path and no box-2
// consent is needed for it. The copy rules are enforced by tests:
//   - butler tone, plain warm words, no emojis, no exclamation marks;
//   - money figures come ONLY from the settlement ledger (SplitLedgerEntry)
//     and reconcile to the cent with reconcileCollected();
//   - the push text never carries a client name (lock-screen privacy).

import type { BriefMode } from '../coach-brief.types';

export type RomanHonorific = 'first_name' | 'sir' | 'maam';
export const ROMAN_HONORIFICS: readonly RomanHonorific[] = ['first_name', 'sir', 'maam'];

export function isRomanHonorific(v: unknown): v is RomanHonorific {
  return typeof v === 'string' && (ROMAN_HONORIFICS as readonly string[]).includes(v);
}

/** The money window: the 24 hours that end when the brief is generated. */
export const ROMAN_MONEY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Ledger kinds that pay the coach (the platform fee row is excluded). */
export const COACH_PAYOUT_LEDGER_KINDS: readonly string[] = ['destination', 'head_coach_split'];
/** Ledger states that represent money that actually moved to the coach. */
export const SETTLED_LEDGER_STATUSES: readonly string[] = ['posted', 'reversed'];

// Stripe zero-decimal currencies: amounts are whole units, not cents.
const ZERO_DECIMAL_CURRENCIES = new Set([
  'bif',
  'clp',
  'djf',
  'gnf',
  'jpy',
  'kmf',
  'krw',
  'mga',
  'pyg',
  'rwf',
  'ugx',
  'vnd',
  'vuv',
  'xaf',
  'xof',
  'xpf',
]);

export interface SettlementLedgerRow {
  purchase_id: string;
  kind: string;
  status: string;
  payee_user_id: string | null;
  amount_cents: number;
  reversed_cents: number;
  currency: string;
  posted_at: Date | null;
}

export interface RomanMoneyByCurrency {
  currency: string;
  collected_cents: number;
  payments: number;
}

export interface RomanMoney {
  source: 'settlement_ledger';
  window_start: string;
  window_end: string;
  by_currency: RomanMoneyByCurrency[];
}

/**
 * Net money settled to `coachId` inside [windowStart, windowEnd): every
 * SplitLedgerEntry that pays the coach (destination / head_coach_split),
 * posted inside the window, net of any reversal recorded on that slice.
 * Pending and failed slices never count; the platform's application fee
 * never counts; another payee's slice never counts. `payments` is the
 * number of distinct purchases that still contribute a positive amount.
 */
export function reconcileCollected(
  rows: readonly SettlementLedgerRow[],
  coachId: string,
  windowStart: Date,
  windowEnd: Date,
): RomanMoney {
  const totals = new Map<string, { cents: number; purchases: Set<string> }>();
  for (const r of rows) {
    if (r.payee_user_id !== coachId) continue;
    if (!COACH_PAYOUT_LEDGER_KINDS.includes(r.kind)) continue;
    if (!SETTLED_LEDGER_STATUSES.includes(r.status)) continue;
    if (!r.posted_at) continue;
    const t = r.posted_at.getTime();
    if (t < windowStart.getTime() || t >= windowEnd.getTime()) continue;
    const amount = Math.max(0, Math.trunc(r.amount_cents));
    const reversed = Math.min(amount, Math.max(0, Math.trunc(r.reversed_cents)));
    const net = amount - reversed;
    if (net <= 0) continue;
    const currency = (r.currency || 'usd').toLowerCase();
    const bucket = totals.get(currency) ?? { cents: 0, purchases: new Set<string>() };
    bucket.cents += net;
    bucket.purchases.add(r.purchase_id);
    totals.set(currency, bucket);
  }
  const by_currency = [...totals.entries()]
    .map(([currency, b]) => ({ currency, collected_cents: b.cents, payments: b.purchases.size }))
    .sort((a, b) =>
      a.currency === 'usd' ? -1 : b.currency === 'usd' ? 1 : a.currency.localeCompare(b.currency),
    );
  return {
    source: 'settlement_ledger',
    window_start: windowStart.toISOString(),
    window_end: windowEnd.toISOString(),
    by_currency,
  };
}

export function formatMoney(minorUnits: number, currency: string): string {
  const cur = currency.toLowerCase();
  const zeroDecimal = ZERO_DECIMAL_CURRENCIES.has(cur);
  const major = zeroDecimal ? minorUnits : minorUnits / 100;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: cur.toUpperCase(),
      minimumFractionDigits: zeroDecimal ? 0 : 2,
      maximumFractionDigits: zeroDecimal ? 0 : 2,
    }).format(major);
  } catch {
    // Unknown ISO code: still exact, never a crash.
    return `${major.toFixed(zeroDecimal ? 0 : 2)} ${cur.toUpperCase()}`;
  }
}

/**
 * A display-safe first name: control characters and markup-ish characters
 * removed, whitespace collapsed, first token only, at most 40 characters.
 * Empty input -> null (the caller picks neutral wording).
 */
export function safeFirstName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/[<>{}[\]`*_#|\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const first = cleaned.split(' ')[0] ?? '';
  const capped = first.slice(0, 40);
  return capped.length > 0 ? capped : null;
}

export type RomanLineKind =
  | 'money'
  | 'quiet'
  | 'messages'
  | 'drafts'
  | 'drafts_failed'
  | 'drafts_without_consent'
  | 'check_ins'
  | 'workouts'
  | 'dunning'
  | 'new_clients';

export interface RomanLine {
  kind: RomanLineKind;
  text: string;
  count: number;
  deep_link: string | null;
}

export interface RomanMessagesSummary {
  /** Distinct clients with an unread message. */
  clients: number;
  /** Clients with a ready Roman draft for their latest unread message. */
  drafted: number;
  /** Consenting clients whose draft could not be prepared. */
  drafts_failed: number;
  /** Clients with no live box-2 grant (no AI ran for them). */
  without_ai_consent_clients: number;
  /** Unread messages from those clients. */
  without_ai_consent_messages: number;
}

export interface RomanBriefPayload {
  version: 1;
  honorific: RomanHonorific;
  /** Full butler paragraph: address + lines + closing. */
  text: string;
  lines: RomanLine[];
  closing: string;
  /** Lock-screen push body: no client names, at most 160 characters. */
  push_text: string;
  money: RomanMoney;
  messages: RomanMessagesSummary;
  check_ins_to_review: number;
  workouts_to_approve: number;
}

export interface ComposeRomanInput {
  mode: BriefMode;
  honorific: RomanHonorific;
  coachFirstName: string | null;
  /** 0-23, the coach's local hour at generation time. */
  localHour: number;
  money: RomanMoney;
  /** First names of clients with unread messages, most recent first. */
  messageClientNames: Array<string | null>;
  messages: RomanMessagesSummary;
  checkInsToReview: number;
  workoutsToApprove: number;
  dunningInProgress: number;
  newClients24h: number;
}

export const ROMAN_PUSH_MAX_CHARS = 160;

export function addressFor(
  honorific: RomanHonorific,
  coachFirstName: string | null,
): string | null {
  if (honorific === 'sir') return 'Sir';
  if (honorific === 'maam') return "Ma'am";
  return safeFirstName(coachFirstName);
}

export function closingFor(localHour: number): string {
  if (localHour >= 5 && localHour < 12) return 'Good morning.';
  if (localHour >= 12 && localHour < 17) return 'Good afternoon.';
  return 'Good evening.';
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function joinAmounts(money: RomanMoney): string {
  const parts = money.by_currency.map((c) => formatMoney(c.collected_cents, c.currency));
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function totalPayments(money: RomanMoney): number {
  return money.by_currency.reduce((n, c) => n + c.payments, 0);
}

function messagesLine(names: Array<string | null>, clients: number): string {
  const first = safeFirstName(names[0] ?? null) ?? 'A client';
  if (clients <= 1) return `${first} messaged you.`;
  if (clients === 2) {
    const second = safeFirstName(names[1] ?? null);
    return second
      ? `${first} and ${second} messaged you.`
      : `${first} and 1 other client messaged you.`;
  }
  return `${first} and ${clients - 1} others messaged you.`;
}

function draftsLine(m: RomanMessagesSummary): string | null {
  if (m.drafted <= 0) return null;
  if (m.clients === 1) return 'I have a reply draft ready.';
  if (m.drafted === m.clients) return 'I have reply drafts ready for each of them.';
  return `I have reply drafts ready for ${m.drafted} of them.`;
}

/** Compose the Roman payload. Deterministic for a given input. */
export function composeRomanBrief(input: ComposeRomanInput): RomanBriefPayload {
  const lines: RomanLine[] = [];
  const collected = input.money.by_currency.some((c) => c.collected_cents > 0);
  const payments = totalPayments(input.money);
  const m = input.messages;

  if (collected) {
    lines.push({
      kind: 'money',
      text: `We collected ${joinAmounts(input.money)} in the last 24 hours, across ${payments} ${plural(payments, 'payment', 'payments')}.`,
      count: payments,
      deep_link: 'tgp://coach/money',
    });
  }

  if (input.mode !== 'head_coach') {
    if (m.clients > 0) {
      lines.push({
        kind: 'messages',
        text: messagesLine(input.messageClientNames, m.clients),
        count: m.clients,
        deep_link: 'tgp://coach/brief/drafts',
      });
      const drafts = draftsLine(m);
      if (drafts) {
        lines.push({
          kind: 'drafts',
          text: drafts,
          count: m.drafted,
          deep_link: 'tgp://coach/brief/drafts',
        });
      }
      if (m.drafts_failed > 0) {
        lines.push({
          kind: 'drafts_failed',
          text: `${m.drafts_failed} ${plural(m.drafts_failed, 'message needs', 'messages need')} your own reply; I could not prepare a draft this time.`,
          count: m.drafts_failed,
          deep_link: 'tgp://coach/brief/drafts',
        });
      }
      if (m.without_ai_consent_messages > 0) {
        const n = m.without_ai_consent_messages;
        lines.push({
          kind: 'drafts_without_consent',
          text:
            n === 1
              ? '1 message is from a client who has not enabled AI drafts.'
              : `${n} messages are from clients who have not enabled AI drafts.`,
          count: n,
          deep_link: 'tgp://coach/brief/drafts',
        });
      }
    }
    if (input.checkInsToReview > 0) {
      const n = input.checkInsToReview;
      lines.push({
        kind: 'check_ins',
        text: `${n} ${plural(n, 'check-in is', 'check-ins are')} waiting for your review.`,
        count: n,
        deep_link: 'tgp://coach/check-ins/review',
      });
    }
    if (input.workoutsToApprove > 0) {
      const n = input.workoutsToApprove;
      lines.push({
        kind: 'workouts',
        text: `${n} completed ${plural(n, 'workout is', 'workouts are')} waiting for your approval.`,
        count: n,
        deep_link: 'tgp://coach/workouts/approvals',
      });
    }
  } else {
    if (input.newClients24h > 0) {
      const n = input.newClients24h;
      lines.push({
        kind: 'new_clients',
        text: `${n} new ${plural(n, 'client', 'clients')} joined the team.`,
        count: n,
        deep_link: 'tgp://command-center/team',
      });
    }
    if (input.dunningInProgress > 0) {
      const n = input.dunningInProgress;
      lines.push({
        kind: 'dunning',
        text: `${n} ${plural(n, 'payment is', 'payments are')} in recovery.`,
        count: n,
        deep_link: 'tgp://billing/dunning',
      });
    }
  }

  if (lines.length === 0) {
    lines.push({
      kind: 'quiet',
      text: 'All is quiet. Nothing came in over the last 24 hours that needs you.',
      count: 0,
      deep_link: null,
    });
  }

  const address = addressFor(input.honorific, input.coachFirstName);
  const closing = closingFor(input.localHour);
  const sentences = lines.map((l) => l.text);
  sentences[0] = withAddress(address, sentences[0]);
  const text = `${sentences.join(' ')} ${closing}`;

  return {
    version: 1,
    honorific: input.honorific,
    text,
    lines,
    closing,
    push_text: buildPushText(address, lines, input.money, m, closing),
    money: input.money,
    messages: m,
    check_ins_to_review: input.mode === 'head_coach' ? 0 : input.checkInsToReview,
    workouts_to_approve: input.mode === 'head_coach' ? 0 : input.workoutsToApprove,
  };
}

/** "Sir, we collected ..." — lowercase only a leading "We"/"All". */
function withAddress(address: string | null, sentence: string): string {
  if (!address) return sentence;
  const lead = /^(We|All)\b/.test(sentence)
    ? sentence.charAt(0).toLowerCase() + sentence.slice(1)
    : sentence;
  return `${address}, ${lead}`;
}

/**
 * Push body without client names. Built from the most important facts and
 * trimmed at a sentence boundary so it never ends mid-word.
 */
function buildPushText(
  address: string | null,
  lines: RomanLine[],
  money: RomanMoney,
  m: RomanMessagesSummary,
  closing: string,
): string {
  const parts: string[] = [];
  if (money.by_currency.some((c) => c.collected_cents > 0)) {
    parts.push(`We collected ${joinAmounts(money)} in the last 24 hours.`);
  }
  if (m.clients > 0) {
    const who = `${m.clients} ${plural(m.clients, 'client', 'clients')} messaged you`;
    parts.push(m.drafted > 0 ? `${who}, and I have reply drafts ready.` : `${who}.`);
  }
  for (const l of lines) {
    if (
      l.kind === 'check_ins' ||
      l.kind === 'workouts' ||
      l.kind === 'dunning' ||
      l.kind === 'new_clients'
    ) {
      parts.push(l.text);
    }
  }
  if (parts.length === 0) parts.push(lines[0]?.text ?? 'All is quiet.');
  parts[0] = withAddress(address, parts[0]);
  let out = '';
  for (const p of [...parts, closing]) {
    const next = out ? `${out} ${p}` : p;
    if (next.length > ROMAN_PUSH_MAX_CHARS) break;
    out = next;
  }
  if (!out) out = parts[0].slice(0, ROMAN_PUSH_MAX_CHARS);
  return out;
}

/** Read-back guard for the CoachBrief.roman Json column (no casts). */
export function isRomanBriefPayload(v: unknown): v is RomanBriefPayload {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const o: Record<string, unknown> = { ...v };
  return (
    o.version === 1 &&
    typeof o.text === 'string' &&
    typeof o.push_text === 'string' &&
    typeof o.closing === 'string' &&
    Array.isArray(o.lines) &&
    isRomanHonorific(o.honorific) &&
    typeof o.money === 'object' &&
    o.money !== null &&
    typeof o.messages === 'object' &&
    o.messages !== null
  );
}
