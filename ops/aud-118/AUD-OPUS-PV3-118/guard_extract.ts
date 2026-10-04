import { readdirSync, readFileSync, statSync } from 'fs'; import { join, relative } from 'path';
const LOG_CALL =
  /(?:\b[\w$]*[lL]ogger\b|\b[A-Z_]*LOGGER\b|\bconsole\b|\bnew\s+Logger\([^()]*\))\s*\.\s*(?:log|warn|error|debug|verbose|info|fatal)\s*\(/g;

interface LogCall {
  line: number;
  code: string;
}

function logCalls(src: string): LogCall[] {
  const calls: LogCall[] = [];
  LOG_CALL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LOG_CALL.exec(src)) !== null) {
    const line = src.slice(0, m.index).split('\n').length;
    calls.push({ line, code: argumentCode(src, m.index + m[0].length) });
  }
  return calls;
}

function argumentCode(src: string, start: number): string {
  let out = '';
  let depth = 1;
  let i = start;
  while (i < src.length) {
    const c = src[i];
    if (c === "'" || c === '"') {
      i = skipQuoted(src, i, c);
      out += ' STR ';
      continue;
    }
    if (c === '`') {
      const res = readTemplate(src, i);
      out += ` ${res.exprs.join(' ')} `;
      i = res.end;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      i = close < 0 ? src.length : close + 2;
      continue;
    }
    if (c === '(') depth++;
    if (c === ')') {
      depth--;
      if (depth === 0) break;
    }
    out += c;
    i++;
  }
  return out;
}

function skipQuoted(src: string, i: number, q: string): number {
  i++;
  while (i < src.length && src[i] !== q) {
    if (src[i] === '\\') i++;
    i++;
  }
  return i + 1;
}

function readTemplate(src: string, i: number): { exprs: string[]; end: number } {
  const exprs: string[] = [];
  i++;
  while (i < src.length && src[i] !== '`') {
    if (src[i] === '\\') {
      i += 2;
      continue;
    }
    if (src[i] === '$' && src[i + 1] === '{') {
      let d = 1;
      let j = i + 2;
      let expr = '';
      while (j < src.length && d > 0) {
        const c = src[j];
        if (c === "'" || c === '"') {
          j = skipQuoted(src, j, c);
          expr += ' STR ';
          continue;
        }
        if (c === '`') {
          const inner = readTemplate(src, j);
          expr += ` ${inner.exprs.join(' ')} `;
          j = inner.end;
          continue;
        }
        if (c === '{') d++;
        if (c === '}') {
          d--;
          if (d === 0) break;
        }
        expr += c;
        j++;
      }
      exprs.push(expr);
      i = j + 1;
      continue;
    }
    i++;
  }
  return { exprs, end: i + 1 };
}

/**
 * What a rule sees: the code of one log call, plus whether the file it is
 * in builds a URL from an address (`encodeURIComponent(email)`), where any
 * logged path or URL carries that address (B-700-2).
 */
interface CallContext {
  encodesAddress: boolean;
}

const ENCODES_ADDRESS = /encodeURIComponent\(\s*[\w$.]*e[-_]?mail/i;

// B-700-1: any identifier that holds a person-name token, also inside a
// longer camelCase or snake_case name (`safeCoachName`, `client_display_name`).
const PERSON_NAME_TOKEN =
  /(?:first|last|full|display|guest|user|recipient|coach|client|sender|member|owner|author|person|buyer|contact|given|family|sur|nick)_?names?$/i;

function identifiers(code: string): string[] {
  return code.match(/[A-Za-z_$][\w$]*/g) ?? [];
}

/** Each rule names what it forbids; `hit` gets the code of one log call. */
const RULES: ReadonlyArray<{
  id: string;
  what: string;
  hit: (code: string, ctx: CallContext) => boolean;
}> = [
  {
    id: 'email',
    what: 'an email address (an identifier named like email that is not an id, count, flag or template key)',
    hit: (code) =>
      identifiers(code).some(
        (tok) =>
          /e[-_]?mail/i.test(tok) &&
          !/(?:ids?|count|hash|hashed|kind|status|template|templatekey|key|enabled|verified|sent|service|transport|digest)$/i.test(tok) &&
          !/^(?:EmailService|EmailTemplateKey|EmailSendLog|emailSendLog)$/.test(tok),
      ),
  },
  {
    id: 'recipient',
    what: 'a recipient address (`to`, `input.to`, `args.to`)',
    hit: (code) => /(?:^|[^\w$])(?:[\w$]+\.)?to\b(?!\s*:)/.test(code.replace(/\bSTR\b/g, '')),
  },
  {
    id: 'name',
    what: "a person's name (an identifier holding a person-name token, or `<person>.name`)",
    hit: (code) =>
      identifiers(code).some((tok) => PERSON_NAME_TOKEN.test(tok)) ||
      /\b(?:user|client|coach|u|member|recipient|sender|owner|guest|profile|buyer|person|author|actor)\.name\b/.test(code),
  },
  {
    id: 'free-text',
    what: 'free text: a message body, note, alert or provider message, or a whole request payload',
    hit: (code) =>
      /\b(?:alert|ticket|receipt|post|comment|reply|thread|dm|chat|conversation|checkin|checkIn|entry|draft|lesson|application|listing|result|input|dto|body|payload|data)\.(?:message|body|content|text|note|notes|caption|bio|title|prompt|transcript)\b(?!\s*\??\.\s*length\b)/.test(
        code,
      ) ||
      /\btruncateNote\s*\(/.test(code) ||
      /\b(?:JSON\.stringify|safeStringify|inspect)\s*\(\s*(?:body|payload|dto|input|data|req\.body|request\.body)\b/.test(
        code,
      ),
  },
  {
    id: 'path',
    what: 'a raw request URL, or a path or URL in a file that puts an address into a URL',
    hit: (code, ctx) =>
      /\b(?:req|request)\s*\.\s*(?:originalUrl|url)\b/.test(code) ||
      (ctx.encodesAddress && /(?:^|[^\w$.])(?:path|url|uri|href|fullUrl)\b(?!\s*:)/.test(code)),
  },
  {
    id: 'exception-text',
    what: 'exception or provider text (`.message`, `.stack`, `String(err)`, a bare error argument, an error-message helper) instead of describeFailure(err)',
    hit: (code) => {
      const c = code.replace(/\bdescribeFailure\s*\([^()]*\)/g, ' SAFE ');
      return (
        /\.\s*(?:message|stack)\b/.test(c) ||
        /\bString\s*\(\s*(?:err|error|e|ex|exception|cause|reason)\b/.test(c) ||
        /(?:^|[^\w$.])(?:message|msg|errMsg|errorMessage|errMessage)\b(?!\s*:)/.test(c) ||
        /(?:^|[,(]\s*)(?:err|error|e|ex|exception|cause)\s*(?:,|$)/.test(c.trim()) ||
        /\b[\w$]*[mM]essage(?:Of|For|From)?\s*\(/.test(c)
      );
    },
  },
];

function violations(code: string, ctx: CallContext = { encodesAddress: false }): string[] {
  return RULES.filter((r) => r.hit(code, ctx)).map((r) => r.id);
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === '__tests__' || name === '__mocks__' || name === 'node_modules') continue;
      out.push(...sourceFiles(p));
    } else if (name.endsWith('.ts') && !/\.(?:spec|test)\.ts$/.test(name) && !name.endsWith('.d.ts')) {
      out.push(p);
    }
  }
  return out;
}

/**
 * C-700-2 legacy baseline: log calls that still print exception text, per
 * file, exact counts at agent 118 (B-PRIVFU2-118). Every other rule has no
 * baseline. A file not listed must have none; a listed count that grows or
 * shrinks fails, so the list is lowered as sites move to describeFailure.
 * Files this PR touches are fixed and are not listed.
 */
const LEGACY_EXCEPTION_TEXT: Readonly<Record<string, number>> = {
  'src/account-deletion/account-deletion.service.ts': 5,
  'src/account-deletion/apple-token-revocation.service.ts': 3,
  'src/admin/admin.service.ts': 1,
  'src/admin/ptm/admin-ptm.service.ts': 1,
  'src/admin/soc2/soc2-evidence.service.ts': 3,
  'src/ai-credits/coach-ai-budget.scheduler.ts': 1,
  'src/ai-credits/coach-ai-credit-pack.service.ts': 1,
  'src/ai/adapters/anthropic.adapter.ts': 2,
  'src/ai/ai.service.ts': 2,
  'src/ai/coach/coach-ai-state.service.ts': 1,
  'src/ai/coach/weekly-insight.cron.ts': 1,
  'src/ai/gateway/ai-approval.service.ts': 1,
  'src/ai/gateway/ai-gateway.service.ts': 2,
  'src/ai/gateway/materialisers/assign-meal-plan.materialiser.ts': 2,
  'src/ai/gateway/materialisers/assign-workout.materialiser.ts': 2,
  'src/ai/gateway/materialisers/coach-message.materialiser.ts': 2,
  'src/ai/gateway/materialisers/coach-wearable-message.materialiser.ts': 2,
  'src/ai/gateway/materialisers/create-workout-plan.materialiser.ts': 1,
  'src/ai/gateway/materialisers/edit-workout-plan.materialiser.ts': 1,
  'src/ai/gateway/materialisers/send-notification.materialiser.ts': 1,
  'src/analytics/analytics.service.ts': 1,
  'src/audit/audit.service.ts': 1,
  'src/auth/jwks.service.ts': 1,
  'src/auth/recent-auth.guard.ts': 1,
  'src/billing/billing.service.ts': 10,
  'src/bloodwork/bloodwork-stale.scheduler.ts': 1,
  'src/checkout/checkout-webhook-handler.service.ts': 14,
  'src/checkout/checkout.service.ts': 2,
  'src/checkout/dunning-v2/dunning-lockout.guard.ts': 1,
  'src/checkout/dunning-v2/dunning-lockout.scheduler.ts': 1,
  'src/checkout/dunning-v2/dunning-v2.dispatcher.ts': 1,
  'src/checkout/dunning-v2/dunning-v2.service.ts': 1,
  'src/checkout/dunning.service.ts': 6,
  'src/checkout/purchase-split-handler.service.ts': 2,
  'src/checkout/refund-dispute-handler.service.ts': 5,
  'src/coach-connect/coach-connect.service.ts': 2,
  'src/coach-media/coach-media.service.ts': 1,
  'src/coach-media/supabase-storage.provider.ts': 2,
  'src/coach/brief/coach-brief.scheduler.ts': 6,
  'src/coach/coach-effectiveness.scheduler.ts': 2,
  'src/coach/command-center/churn-intervention.service.ts': 3,
  'src/common/cors-origins.ts': 1,
  'src/common/env-validation.ts': 6,
  'src/common/feature-flag/pilot-coach-allowlist.guard.ts': 2,
  'src/common/interceptors/rls-context.interceptor.ts': 1,
  'src/common/middleware/rls-context.middleware.ts': 2,
  'src/community/ai-triage/ai-triage.service.ts': 2,
  'src/community/classroom/community-classroom.service.ts': 1,
  'src/community/events/community-events.scheduler.ts': 1,
  'src/community/moderation/community-moderation.service.ts': 1,
  'src/community/notifications/community-notifications.service.ts': 1,
  'src/community/realtime/community-realtime.service.ts': 2,
  'src/community/voice/community-voice.service.ts': 1,
  'src/community/voice/voice-upload.provider.ts': 7,
  'src/connect/connect.module.ts': 2,
  'src/connect/connect.service.ts': 1,
  'src/connect/fees/payout-readiness.service.ts': 4,
  'src/connect/fees/reconciliation.service.ts': 3,
  'src/connect/fees/transfer-orchestrator.service.ts': 1,
  'src/consent/consent.service.ts': 1,
  'src/contracts/contract-envelope.service.ts': 2,
  'src/contracts/webhooks/hellosign-webhook.controller.ts': 3,
  'src/data-export/data-export-archive.store.ts': 1,
  'src/data-export/data-export-cleanup.cron.ts': 1,
  'src/data-export/data-export.controller.ts': 1,
  'src/data-export/data-export.service.ts': 11,
  'src/diagnostic/ai-roadmap.service.ts': 1,
  'src/diagnostic/diagnostic.service.ts': 1,
  'src/exercise-catalog/exercise-video-provider.service.ts': 11,
  'src/exercise-library/exercise-library.service.ts': 1,
  'src/filters/http-exception.filter.ts': 1,
  'src/first-win/first-win.service.ts': 1,
  'src/food/food.service.ts': 1,
  'src/invite-codes/invite-codes.service.ts': 5,
  'src/invite-grant/invite-grant.service.ts': 1,
  'src/landing-pages/crm/lead-sync.processor.ts': 3,
  'src/landing-pages/landing-pages.public.service.ts': 2,
  'src/landing-pages/lead-rate-limiter.service.ts': 2,
  'src/leaderboard/leaderboard.scheduler.ts': 1,
  'src/leaderboard/leaderboard.service.ts': 1,
  'src/messaging/messaging.service.ts': 1,
  'src/notifications/emitters/booking.emitter.ts': 1,
  'src/notifications/emitters/build-week-day-unlocked.emitter.ts': 1,
  'src/notifications/emitters/checkin-submitted.emitter.ts': 1,
  'src/notifications/emitters/coach-alert.emitter.ts': 1,
  'src/notifications/emitters/message-received.emitter.ts': 1,
  'src/notifications/emitters/milestone-reached.emitter.ts': 1,
  'src/notifications/emitters/missed-checkin.emitter.ts': 1,
  'src/notifications/emitters/weight-trend-alert.emitter.ts': 1,
  'src/notifications/nudges/nudge-engine.service.ts': 7,
  'src/notifications/nudges/nudge.scheduler.ts': 2,
  'src/packages/asset-resolvers/auto-message.resolver.ts': 1,
  'src/packages/drip-dispatcher.cron.ts': 5,
  'src/packages/drip-trigger.service.ts': 2,
  'src/packages/milestone.service.ts': 1,
  'src/packages/package-contents.service.ts': 1,
  'src/packages/package-push.service.ts': 4,
  'src/packages/purchase-fanout.service.ts': 4,
  'src/ptm/ptm-recompute.service.ts': 2,
  'src/ptm/ptm.scheduler.ts': 1,
  'src/ptm/ptm.service.ts': 1,
  'src/roman/roman.service.ts': 1,
  'src/scheduling/google-calendar/google-calendar.service.ts': 2,
  'src/scheduling/jobs/reminder.job.ts': 1,
  'src/scheduling/scheduling-session-lifecycle.service.ts': 1,
  'src/storefront/checkout-cookie.service.ts': 1,
  'src/storefront/checkout-idempotency.service.ts': 3,
  'src/storefront/checkout-rate-limiter.service.ts': 2,
  'src/storefront/checkout-receipt.scheduler.ts': 2,
  'src/storefront/checkout-receipt.service.ts': 4,
  'src/storefront/connect-preflight.service.ts': 4,
  'src/storefront/guest-checkout-pii-scrub.service.ts': 2,
  'src/storefront/guest-checkout-reconciliation.service.ts': 3,
  'src/storefront/guest-checkout.service.ts': 2,
  'src/storefront/lost-webhook-reconcile.service.ts': 5,
  'src/sub-coach/sub-coach-idempotency.service.ts': 2,
  'src/supabase/supabase.service.ts': 2,
  'src/talent-marketplace/admin-moderation.service.ts': 1,
  'src/talent-marketplace/anti-bot/in-house-anti-bot.provider.ts': 2,
  'src/team/team.service.ts': 1,
  'src/throttler/login-throttle-reset.service.ts': 3,
  'src/throttler/throttler.config.ts': 2,
  'src/wearables/connections/connections.service.ts': 1,
  'src/wearables/connectors/fitbit/fitbit-webhook.controller.ts': 1,
  'src/wearables/connectors/fitbit/fitbit.connector.ts': 2,
  'src/wearables/connectors/oura/oura-webhook.controller.ts': 1,
  'src/wearables/connectors/oura/oura.connector.ts': 1,
  'src/wearables/connectors/polar/polar-webhook.controller.ts': 1,
  'src/wearables/connectors/polar/polar.connector.ts': 2,
  'src/wearables/connectors/wahoo/wahoo-webhook.controller.ts': 1,
  'src/wearables/connectors/wahoo/wahoo.connector.ts': 2,
  'src/wearables/connectors/withings/withings-webhook.controller.ts': 1,
  'src/wearables/connectors/withings/withings.connector.ts': 2,
  'src/wearables/http/provider-http-client.ts': 1,
  'src/wearables/ingestion/ingestion.service.ts': 2,
  'src/wearables/insights/wearable-insights.service.ts': 3,
  'src/wearables/maintenance/wearable-processed-event-prune.scheduler.ts': 1,
  'src/wearables/samples/wearable-samples.service.ts': 2,
  'src/workout-builder/program-library.service.ts': 2,
  'src/workout-builder/workout-builder-revision-prune.cron.ts': 2,
  'src/workout-builder/workout-builder.service.ts': 2,
};

export { logCalls, violations, sourceFiles, LEGACY_EXCEPTION_TEXT, ENCODES_ADDRESS, RULES };
