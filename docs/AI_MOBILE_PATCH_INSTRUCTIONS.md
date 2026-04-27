# Mobile patch instructions: switch AI chat to backend ClientAIContext

The fitness backend now builds a server-side `ClientAIContext` and runs all
prompts and guardrails through it. The mobile client must stop relying on
the local keyword matcher for the main AI surfaces and call `POST /ai/chat`
with the user's question only.

## Contract reminder

Mobile sends ONLY:

```json
POST /ai/chat
Authorization: Bearer <supabase_access_token>
{
  "message": "string, required",
  "conversation_history": [{ "role": "user" | "assistant", "content": "string" }]
}
```

Mobile MUST NOT send profile, macros, weight, logs, or any context. The
backend pulls all of that from the authenticated `userId`.

Response (always):

```json
{
  "reply": "string",
  "timestamp": "ISO-8601",
  "debug": {                        // present only when NODE_ENV != production
    "guardrails_applied": ["..."],
    "context_generated_at": "ISO-8601",
    "model_used": "perplexity" | "fallback"
  }
}
```

Disclosure surface (optional but recommended):

```
GET /ai/structured-context
```

Returns the typed `ClientAIContext` so the mobile app can render a
"What does GP know about you" disclosure screen sourced from the same
data the model receives.

## Files to patch in `growth-project-mobile`

The exact paths below are the canonical files in the mobile repo. If any of
these have moved, search for `aiApi` and the `local keyword matcher` first.

### 1. `services/aiApi.ts` (or wherever the AI client lives)

Replace the keyword-matcher-first flow with a backend-first flow. Pseudo-diff:

```ts
// BEFORE: local matcher for canned responses, backend only on miss.
// AFTER: backend first, local matcher only as offline fallback.
export async function aiChat(
  message: string,
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [],
): Promise<{ reply: string; offline: boolean }> {
  try {
    const token = await getSupabaseAccessToken();
    const res = await fetch(`${API_BASE_URL}/ai/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ message, conversation_history: conversationHistory.slice(-10) }),
    });
    if (!res.ok) throw new Error(`ai_chat_${res.status}`);
    const data = (await res.json()) as { reply: string };
    return { reply: data.reply, offline: false };
  } catch (e) {
    // Premium fallback copy. Quiet luxury, no exclamation marks, no emoji.
    return {
      reply:
        'I cannot reach the coaching service right now. Try again in a moment, or message your coach if it is urgent.',
      offline: true,
    };
  }
}
```

### 2. `screens/AIScreen.tsx` (or `AIChatScreen.tsx`)

- Remove any imports of the local keyword matcher (`localAIMatcher`,
  `keywordMatch`, `cannedResponses`, etc.) from the main chat path.
- Keep them only behind `__DEV__` for debugging, OR delete entirely.
- Call `aiChat(message, history)` directly. Render `reply` verbatim; do
  NOT post-process punctuation on the client (the server already strips
  em-dashes and exclamation marks).

```tsx
const onSubmit = async (text: string) => {
  setHistory((h) => [...h, { role: 'user', content: text }]);
  setSending(true);
  const { reply, offline } = await aiChat(text, history);
  setHistory((h) => [...h, { role: 'assistant', content: reply }]);
  setSending(false);
  if (offline) showQuietBanner('Offline. Showing a saved response.');
};
```

### 3. `screens/AIDisclosureScreen.tsx` (NEW, optional)

If the team wants a "what GP knows about you" surface, add a screen that
fetches `GET /ai/structured-context` and renders the typed shape. Helps
trust and matches the requirement "AI must know X, Y, Z" by exposing it.

Recommended sections (in this order):
1. Profile (name, age, sex, height, weight, target)
2. App-prescribed targets (calories, protein, carbs, fat, water, meals/day)
3. Today's running total (with a remaining-cal chip)
4. Last 7 days adherence (mini sparklines)
5. Recent workouts (last 5)
6. Habit completion (14d)
7. Coach: name, last message excerpt, active guidelines
8. Active meal plan (if any)

### 4. Premium offline copy

The single offline string the app should ship:

> "I cannot reach the coaching service right now. Try again in a moment,
> or message your coach if it is urgent."

No exclamation marks, no em-dashes, no emoji. Matches the quiet luxury tone.

## Things to delete (or move out of the main path)

- Local keyword matcher in `lib/ai/keywordMatcher.ts` (or similar). If the
  product wants a "snappy" suggestion-chip experience, keep that as a
  separate feature. The chat surface itself should be backend-only.
- Any client-side macro math used to build the AI prompt. The server is
  now authoritative.
- Any `mock` or `placeholder` profile send-along. The server ignores it
  anyway.

## Verification checklist (mobile QA)

- [ ] Chat hits `POST /ai/chat` with `Authorization` header
- [ ] Request body contains only `message` and optional `conversation_history`
- [ ] Replies render server-strings verbatim
- [ ] Offline path shows premium fallback copy
- [ ] In dev builds, `debug.guardrails_applied` is logged for QA visibility
- [ ] Disclosure screen (if shipped) shows real coach name, real macros,
      and matches the values on the Profile screen
