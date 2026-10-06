import { TRIAGE_CATEGORIES } from '../triage-output.schema';

// v2-4 — community AI inbox-triage prompt builder.
//
// Persona: a triage assistant TO the coach. Given a list of the coach's
// UNANSWERED community inbox items (each already fetched + tenant-bounded by
// the service — the prompt layer never touches the database), it CLASSIFIES
// each item into exactly one of the five categories and writes a short,
// neutral one-line summary derived from the item's own text. It NEVER drafts a
// reply, never invents items, and never references any item id not present in
// the input list.
//
// The builder is PURE — it shapes the prompt from data the service hands in.
// Tenant isolation is the service's responsibility (it only ever passes items
// from cohorts the requesting coach actually coaches); the prompt additionally
// instructs the model to use ONLY the listed items so a stray id can never be
// fabricated.

// Bump deliberately on any copy change so cached outputs tie back to the exact
// prompt revision that produced them (prompt-version pinning, EMBEDDED_AI_SPEC
// §4). A copy edit is a version bump, never silent drift.
export const PROMPT_VERSION = 'community-inbox-triage-v1';

// A sanitised inbox item the prompt reasons over. Decoupled from the Prisma
// row so the prompt never embeds sensitive columns — only the id, kind, a
// trimmed body preview, the cohort name, the author's display name, and the
// item's age in hours (the only signal the model needs for urgency).
export interface TriagePromptItem {
  id: string;
  kind: 'message' | 'post';
  preview: string;
  cohortName: string;
  authorDisplayName: string;
  ageHours: number;
}

export interface TriagePromptResult {
  system: string;
  user: string;
}

// Plain-language descriptions of each category so the model classifies
// consistently. Calm + professional framing — `urgent` is a prioritisation
// signal for the coach, never an alarmist or medical claim.
const CATEGORY_GUIDE: Record<(typeof TRIAGE_CATEGORIES)[number], string> = {
  urgent:
    'time-sensitive and clearly needs the coach soon: a direct question awaiting an answer, a blocker, a scheduling conflict, or visible frustration. Professional prioritisation only — never imply a medical or emergency situation.',
  win_to_celebrate:
    "a client sharing progress, a milestone, a personal best, or positive news the coach can acknowledge.",
  form_check:
    'a request to review technique, a form video, or a how-do-I-do-this movement question.',
  general:
    'a normal conversational message or post that benefits from a reply but is not time-critical.',
  no_action_needed:
    'chatter, thanks, an emoji-style acknowledgement, or something already self-resolved that does not need a coach reply.',
};

function buildSystemPrompt(): string {
  const categoryLines = TRIAGE_CATEGORIES.map(
    (c) => `  - "${c}": ${CATEGORY_GUIDE[c]}`,
  ).join('\n');
  return [
    'You are an inbox-triage assistant helping a fitness coach prioritise their community inbox.',
    'You are given a list of UNANSWERED items (client messages and posts) the coach has not yet replied to.',
    'Your only job is to CLASSIFY each item into exactly one category and write a short neutral one-line summary of what the item is about.',
    '',
    'Categories (use these exact strings, choose exactly one per item):',
    categoryLines,
    '',
    'Hard rules:',
    '  - Classify ONLY the items in the provided list. Never invent an item or an id.',
    '  - Use ONLY the item ids exactly as given. Do not output any id not in the list.',
    '  - The summary is a reading aid that paraphrases the item; it is NEVER a drafted reply, advice, or a message to the client.',
    '  - Do NOT diagnose, do NOT give medical or clinical interpretation, do NOT use alarmist language. Keep "urgent" professional.',
    '  - Each summary must be at most 280 characters.',
    '',
    'Output ONLY a single JSON object, no prose, no markdown fences, matching:',
    '{ "buckets": [ { "category": <one of the categories>, "items": [ { "source_item_id": <id>, "source_kind": "message"|"post", "category": <same category>, "summary": <string> } ] } ] }',
    `Return exactly ${TRIAGE_CATEGORIES.length} buckets, one per category above, in that order. A category with no items has an empty "items" array.`,
  ].join('\n');
}

function renderItems(items: TriagePromptItem[]): string {
  if (items.length === 0) {
    return 'NO_ITEMS — the coach inbox has no unanswered items to triage.';
  }
  return items
    .map((it) => {
      const preview = it.preview.replace(/\s+/g, ' ').trim().slice(0, 240);
      return [
        `- id: ${it.id}`,
        `  kind: ${it.kind}`,
        `  cohort: ${it.cohortName}`,
        `  from: ${it.authorDisplayName}`,
        `  age_hours: ${it.ageHours}`,
        `  text: ${preview}`,
      ].join('\n');
    })
    .join('\n');
}

export default function buildInboxTriagePrompt(
  items: TriagePromptItem[],
): TriagePromptResult {
  return {
    system: buildSystemPrompt(),
    user: [
      'Triage the following unanswered inbox items. Classify every item exactly once.',
      '',
      renderItems(items),
    ].join('\n'),
  };
}
