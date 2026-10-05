import sys,re
root=sys.argv[1]
def load(p): return open(root+'/'+p).read()
def save(p,s): open(root+'/'+p,'w').write(s)
def rep(s,old,new,cnt=1):
    assert s.count(old)==cnt, (old[:90], s.count(old))
    return s.replace(old,new)
p='src/roman/roman.service.ts'; s=load(p)
s=rep(s,"import { AuditService } from '../audit/audit.service';","import { AuditAction, AuditService } from '../audit/audit.service';")
s=rep(s,"""  ROMAN_SAFETY_ROUTER_MODEL_ID,
  ROMAN_SAFETY_TEMPLATES,""","""  ROMAN_SAFETY_ROUTE_REASON,
  ROMAN_SAFETY_ROUTER_MODEL_ID,
  ROMAN_SAFETY_TEMPLATES,""")
s=rep(s,"""      this.logger.warn(
        `roman.turn session=${session.id} prompt_version=${PROMPT_VERSION} router=${route.class} model_call=false`,
      );
      await this.audit?.write({
        action: route.class === 'emergency' ? 'roman.safety_emergency' : 'roman.safety_self_harm',
        actorId: caller.id,
        actorRole: caller.role,
        targetType: 'RomanSession',
        targetId: session.id,
      });""","""      // OR-115-1 (C-651-5): one neutral action name and no class in the log
      // line. The closed reason code lives only in AuditLog.metadata, which
      // the owner audit list never returns and #608's erasure manifest nulls
      // for this actor.
      this.logger.warn(
        `roman.turn session=${session.id} prompt_version=${PROMPT_VERSION} model_call=false template=fixed`,
      );
      await this.audit?.write({
        action: AuditAction.ROMAN_SAFETY_ROUTE,
        actorId: caller.id,
        actorRole: caller.role,
        targetType: 'RomanSession',
        targetId: session.id,
        metadata: { route_reason: ROMAN_SAFETY_ROUTE_REASON[route.class] },
      });""")
s=rep(s,"""    const poolCoachId = await this.assertCoachPoolOpen(caller);
    const reservation = await this.reserveDailySpend(caller);
    // Every settle path that spent tokens also debits the coach pool.
    const settle = async (
      inputTokens: number,
      outputTokens: number,
      metadata: Record<string, string | number | boolean | string[] | null>,
    ): Promise<void> => {
      await this.settleSpend(reservation, inputTokens, outputTokens, metadata);
      await this.debitCoachPool(poolCoachId, inputTokens, outputTokens, reservation);
    };
""","""    const poolCoachId = await this.assertCoachPoolOpen(caller);
""")
s=rep(s,"""    const messages = await this.buildContextTurns(session.id);

    let acc = '';
    let interrupted = false;
    let failed = false;
    let promptTokens: number | null = null;
    let completionTokens: number | null = null;
""","""    // B-651-4: the reservation is an upper bound of THIS payload, built from
    // the exact system prompt and history that will be sent (trimmed to the
    // enforceable input budget, oldest turns first), never a fixed estimate.
    const payload = boundRomanPayload(system, await this.buildContextTurns(session.id));
    const messages = payload.messages;
    const reservation = await this.reserveDailySpend(caller, payload.inputTokenBound);
    // Every settle path that spent tokens also debits the coach pool (B-668-1).
    const settle = async (
      inputTokens: number,
      outputTokens: number,
      metadata: Record<string, string | number | boolean | string[] | null>,
    ): Promise<void> => {
      await this.settleSpend(reservation, inputTokens, outputTokens, metadata);
      await this.debitCoachPool(poolCoachId, inputTokens, outputTokens, reservation);
    };

    let acc = '';
    let interrupted = false;
    let failed = false;
    let promptTokens: number | null = null;
    let completionTokens: number | null = null;
    // B-651-1: what is known about provider usage. `dispatched` turns true the
    // moment the request is handed to the SDK; `usageFinal` only when the final
    // message_delta carried the output count. A provider HTTP error before any
    // event (it answered with an error status) generated nothing.
    let dispatched = false;
    let sawEvent = false;
    let usageFinal = false;
    let providerRejected = false;
""")
s=rep(s,"""    try {
      const stream = await this.egress.anthropicMessagesStream(""","""    try {
      dispatched = true;
      const stream = await this.egress.anthropicMessagesStream(""")
s=rep(s,"""      for await (const event of stream) {
        if (opts.signal?.aborted) {""","""      for await (const event of stream) {
        sawEvent = true;
        if (opts.signal?.aborted) {""")
s=rep(s,"""        } else if (event.type === 'message_delta') {
          completionTokens = event.usage?.output_tokens ?? completionTokens;
        }""","""        } else if (event.type === 'message_delta') {
          const out = event.usage?.output_tokens;
          if (typeof out === 'number') {
            completionTokens = out;
            usageFinal = true;
          }
        }""")
s=rep(s,"""        await settle(0, 0, { outcome: 'refused' });
        throw err;
      }
      interrupted = true;
      failed = !opts.signal?.aborted;
      this.logger.warn(
        `roman.stream_error session=${session.id}: ${romanErrorTag(err)}`,
      );""","""        // Refused by the consent gate before anything was sent: known zero.
        await settle(0, 0, { outcome: 'refused', usage: 'none_sent' });
        throw err;
      }
      interrupted = true;
      failed = !opts.signal?.aborted;
      providerRejected = !sawEvent && isProviderHttpError(err);
      this.logger.warn(`roman.stream_error session=${session.id}: ${romanErrorTag(err)}`);""")
s=rep(s,"""    if (failed && acc.trim().length === 0) {
      await settle(promptTokens ?? 0, completionTokens ?? 0, {
        outcome: 'model_error',
      });""","""    if (promptTokens !== null && promptTokens > payload.inputTokenBound) {
      // Should be impossible (tokens never exceed bytes); surfaced so the
      // bound can be corrected if a provider ever counts differently.
      this.logger.warn(
        `roman.input_bound_exceeded session=${session.id} reported=${promptTokens} bound=${payload.inputTokenBound}`,
      );
    }
    const usage = settledUsage({
      dispatched,
      providerRejected,
      usageFinal,
      promptTokens,
      completionTokens,
      inputTokenBound: payload.inputTokenBound,
    });
    if (failed && acc.trim().length === 0) {
      await settle(usage.input, usage.output, {
        outcome: 'model_error',
        usage: usage.kind,
      });""")
s=rep(s,"""      exclamationAllowed: !session.exclamation_used,""","""      exclamationAllowed: false,""")
s=rep(s,"""        interrupted,
        // The voice contract allows ONE exclamation per session: once a stored
        // reply carries it, the session records it so the next turn's prompt
        // and post-check allow none.
        spendsExclamation: !session.exclamation_used && checked.text.includes('!'),
      });""","""        interrupted,
      });""")
s=rep(s,"""      await settle(promptTokens ?? 0, completionTokens ?? 0, {
        outcome: err instanceof NotFoundException ? 'session_gone' : 'persist_failed',
        router_class: route.class,
      });""","""      await settle(usage.input, usage.output, {
        outcome: err instanceof NotFoundException ? 'session_gone' : 'persist_failed',
        usage: usage.kind,
      });""")
s=rep(s,"""    await settle(promptTokens ?? 0, completionTokens ?? 0, {
      outcome: interrupted ? 'interrupted' : 'ok',
      router_class: route.class,
      guardrails_applied: checked.guardrails_applied,""","""    // OR-115-1: no router class and no guardrail names in the ledger (they
    // are health inferences); only whether the reply was rewritten and how
    // many checks fired.
    await settle(usage.input, usage.output, {
      outcome: interrupted ? 'interrupted' : 'ok',
      usage: usage.kind,
      rewritten: checked.rewritten,
      guardrail_count: checked.guardrails_applied.length,""")
s=rep(s,"""      `roman.turn session=${session.id} prompt_version=${PROMPT_VERSION} router=${route.class} model_call=true rewritten=${checked.rewritten} guardrails_applied=${JSON.stringify(checked.guardrails_applied)} context=${bundle ? bundle.hash.slice(0, 12) : grounded ? 'unavailable' : 'none'}`,""","""      `roman.turn session=${session.id} prompt_version=${PROMPT_VERSION} model_call=true rewritten=${checked.rewritten} guardrail_count=${checked.guardrails_applied.length} usage=${usage.kind} context=${bundle ? bundle.hash.slice(0, 12) : grounded ? 'unavailable' : 'none'}`,""")
# reserveDailySpend
start=s.index("""  /**
   * Reserve this turn's worst-case cost in the content-free ledger, then""")
end=s.index("""    } catch (err) {
      this.logger.error(`roman.spend_ledger_failed: ${romanErrorTag(err)}`);""", start)
s=s[:start]+"""  /**
   * B-651-4 / B-651-5: admit this turn only if today's total PLUS this turn's
   * upper-bound cost (exact payload bound + max output) stays within the cap,
   * and do the compare and the reservation insert atomically. A transaction-
   * scoped advisory lock keyed on the UTC day serialises every admission
   * across replicas, so two concurrent affordable turns can never both be
   * rejected, and admitted reservations never sum above the cap. Over the
   * cap: nothing is inserted and the turn is a coded 503 with specific copy.
   * Any ledger failure: coded 503, no provider call (fail closed).
   */
  async reserveDailySpend(caller: RomanCaller, inputTokenBound: number): Promise<string> {
    const requestId = `roman:${randomUUID()}`;
    const cap = this.dailyCostCapUsd();
    const now = new Date();
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const dayKey = Math.floor(dayStart.getTime() / 86_400_000);
    const promptReserve = Math.max(0, Math.ceil(inputTokenBound));
    const reserveUsd = RomanService.costUsd(promptReserve, ROMAN_MAX_OUTPUT_TOKENS);
    let admitted: boolean;
    try {
      admitted = await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ROMAN_SPEND_LOCK_NAMESPACE}::int4, ${dayKey}::int4)`;
        const agg = await tx.aiRequestAudit.aggregate({
          where: { capability: ROMAN_LEDGER_CAPABILITY, created_at: { gte: dayStart } },
          _sum: { prompt_token_estimate: true, response_token_estimate: true },
        });
        const used = RomanService.costUsd(
          agg._sum.prompt_token_estimate ?? 0,
          agg._sum.response_token_estimate ?? 0,
        );
        if (used + reserveUsd > cap) return false;
        await tx.aiRequestAudit.create({
          data: {
            request_id: requestId,
            capability: ROMAN_LEDGER_CAPABILITY,
            requester_id: caller.id,
            requester_role: caller.role,
            subject_user_id: caller.role === 'student' ? caller.id : null,
            provider: 'anthropic',
            model: ROMAN_MODEL_PHASE_1,
            enabled: true,
            prompt_token_estimate: promptReserve,
            response_token_estimate: ROMAN_MAX_OUTPUT_TOKENS,
            metadata: { state: 'reserved' },
          },
        });
        return true;
      });
"""+s[end:]
s=rep(s,"""    if (used > cap) {
      await this.settleSpend(requestId, 0, 0, { outcome: 'over_cap' });
      this.logger.warn(`roman.capacity_reached cap_usd=${cap}`);""","""    if (!admitted) {
      this.logger.warn(`roman.capacity_reached cap_usd=${cap}`);""")
# helpers after class: insert before postCheckContextOf doc
s=rep(s,"""/**
 * The typed facts the post-check may compare against, from the SAME bundle""","""/** pg_advisory_xact_lock namespace for the Roman daily spend admission: ASCII 'rmsp'. */
export const ROMAN_SPEND_LOCK_NAMESPACE = 0x72_6d_73_70;

/**
 * B-651-4: the enforceable input budget of one Roman request. History is
 * trimmed (oldest turns first) only when a payload would exceed it; ordinary
 * chats are far below it, so no turn of a normal conversation is dropped.
 */
export const ROMAN_MAX_INPUT_TOKEN_BOUND = 100_000;
/** Fixed per-request and per-message framing allowance (roles, separators). */
const ROMAN_REQUEST_OVERHEAD_TOKENS = 256;
const ROMAN_MESSAGE_OVERHEAD_TOKENS = 16;

/**
 * An upper bound of the input tokens a payload can cost: the provider's
 * tokenizer never emits more tokens than UTF-8 bytes, plus fixed framing.
 */
export function inputTokenUpperBound(
  system: string,
  messages: ReadonlyArray<{ content: string }>,
): number {
  let bytes = Buffer.byteLength(system, 'utf8') + ROMAN_REQUEST_OVERHEAD_TOKENS;
  for (const m of messages)
    bytes += Buffer.byteLength(m.content, 'utf8') + ROMAN_MESSAGE_OVERHEAD_TOKENS;
  return bytes;
}

/**
 * B-651-4: the exact payload that will be sent and its input-token upper
 * bound. Drops the oldest turns while the bound exceeds the budget, always
 * keeps the newest turn, and never starts the history with a Roman turn.
 */
export function boundRomanPayload(
  system: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  budget: number = ROMAN_MAX_INPUT_TOKEN_BOUND,
): {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  inputTokenBound: number;
  trimmed: number;
} {
  const messages = [...history];
  let trimmed = 0;
  while (messages.length > 1 && inputTokenUpperBound(system, messages) > budget) {
    messages.shift();
    trimmed += 1;
  }
  while (messages.length > 1 && messages[0].role !== 'user') {
    messages.shift();
    trimmed += 1;
  }
  return { messages, inputTokenBound: inputTokenUpperBound(system, messages), trimmed };
}

/** The provider answered with an HTTP error status (it generated nothing). */
function isProviderHttpError(err: unknown): boolean {
  const status = err instanceof Error ? (err as { status?: unknown }).status : undefined;
  return typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599;
}

/**
 * B-651-1: what the ledger settles to. Known usage replaces the reservation;
 * unknown usage after a dispatched request keeps the conservative reserved
 * value for the unknown side (over-counting is the safe side of a hard cap):
 *   - not dispatched, or the provider answered with an HTTP error before any
 *     event: nothing was generated, known zero;
 *   - input unknown (no message_start): the payload's input bound;
 *   - output unknown (no final message_delta): the max output reservation.
 */
export function settledUsage(u: {
  dispatched: boolean;
  providerRejected: boolean;
  usageFinal: boolean;
  promptTokens: number | null;
  completionTokens: number | null;
  inputTokenBound: number;
}): {
  input: number;
  output: number;
  kind: 'none_sent' | 'provider_rejected' | 'final' | 'partial';
} {
  if (!u.dispatched) return { input: 0, output: 0, kind: 'none_sent' };
  if (u.providerRejected) return { input: 0, output: 0, kind: 'provider_rejected' };
  const input = u.promptTokens ?? u.inputTokenBound;
  if (u.usageFinal && u.completionTokens !== null && u.promptTokens !== null) {
    return { input, output: u.completionTokens, kind: 'final' };
  }
  const output =
    u.usageFinal && u.completionTokens !== null ? u.completionTokens : ROMAN_MAX_OUTPUT_TOKENS;
  return { input, output, kind: 'partial' };
}

/**
 * The typed facts the post-check may compare against, from the SAME bundle""")
# dedupe error tag helpers: cut from the content-free error tag doc to EOF
i=s.index("""/**
 * Content-free error tag for Roman's logs and Sentry events""")
s=s[:i]+"""// C-668-4: one copy of the content-free error tag helpers (A's
// roman-error-tag.ts), re-exported for existing importers.
export { ROMAN_LOGGABLE_ERROR_NAMES, romanErrorTag, romanSanitizedError };
"""
s=rep(s,"""import { isRomanChatEnabled } from './roman.feature';""","""import { isRomanChatEnabled } from './roman.feature';
import {
  ROMAN_LOGGABLE_ERROR_NAMES,
  romanErrorTag,
  romanSanitizedError,
} from './roman-error-tag';""")
save(p,s)

p='src/roman/roman.prompts.ts'; s=load(p)
s=rep(s,"""- NO exclamation points, with one exception: a single exclamation per session on a genuine milestone.""","""- NO exclamation points. Ever. A milestone is marked in plain words, never with an exclamation point.""")
s=rep(s,"""  const remainingExclamation = voice.exclamationUsed
    ? 'The single per-session exclamation has already been spent. Do not use an exclamation point for the rest of this session.'
    : 'You may spend the single per-session exclamation point ONLY on a genuine milestone, and only once.';""","""  // B-651-9: shipped replies carry no exclamation marks at all, so the old
  // one-per-session allowance is gone whatever the session recorded.
  const remainingExclamation =
    'Do not use an exclamation point in this reply. Mark a milestone in plain, warm words.';""")
save(p,s)

p='src/roman/roman.constants.ts'; s=load(p)
s=rep(s,""" * reservation, so ordinary launch use never meets it. A turn
 * RESERVES its worst-case cost in the content-free ledger (AiRequestAudit,
 * capability `roman.chat`) before the provider call and settles the actual
 * tokens after it, so concurrent turns see each other. Fail closed: when
 * today's spend cannot be read, no paid call is made.""",""" * reservation, so ordinary launch use never meets it. A turn
 * RESERVES the upper bound of its exact payload plus max output in the
 * content-free ledger (AiRequestAudit, capability `roman.chat`) under a
 * per-day advisory lock before the provider call (B-651-4/5), and settles
 * the known tokens after it, keeping the reserved value for any side whose
 * usage the provider never reported (B-651-1). Fail closed: when today's
 * spend cannot be read, no paid call is made.""")
save(p,s)
print('669 ok')
