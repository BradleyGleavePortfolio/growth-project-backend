# Evidence — Kind→Flag mapping and the γ application site

All citations from commit `4920563` (branch `fix/pr251-r81-rebuild-v2`, PR #263).

## Search kinds (the universe)
`src/api/communitySearchApi.ts:39-46`:
```ts
export const SEARCH_KINDS = [
  'post',
  'classroom_lesson',
  'voice_note_transcript',
  'event',
] as const;
export type CommunitySearchKind = (typeof SEARCH_KINDS)[number];
```

## The γ application site — `CommunityFindScreen.tsx` `open()` callback (F8 open-guard)
`src/screens/community/CommunityFindScreen.tsx:99-158`:
```ts
  const open = useCallback(
    (result: SearchResultRowModel) => {
      // ... analytics (kindToResultType) ...
      setUnavailableKind(null);
      switch (result.kind) {
        case 'post':
          navigation.navigate('CommunityThread', { postId: result.targetId });
          break;
        case 'voice_note_transcript':
          navigation.navigate('CommunityVoiceNoteDetail', {
            voiceNoteId: result.targetId,
            excerpt: result.excerpt,
          });
          break;
        case 'classroom_lesson':
          // F8: classroom surface may be dark for this caller even though a
          // lesson hit surfaced; only open the route when the server flag is ON.
          if (flags.community_classroom) {
            navigation.navigate('CommunityLessonDetail', { postId: result.targetId });
          } else {
            setUnavailableKind('classroom_lesson');
          }
          break;
        case 'event':
          if (flags.community_events) {
            navigation.navigate('CommunityEventDetail', { eventId: result.targetId });
          } else {
            setUnavailableKind('event');
          }
          break;
      }
    },
    [navigation, data, flags.community_classroom, flags.community_events],
  );
```

## CRITICAL nuance: mobile γ is an OPEN-GUARD, not a result-list exclusion
The intersection between search `kind` and the server flag is applied at
**navigation time**, NOT as a filter over the rendered result list:
- `classroom_lesson` / `event` hits **still appear** in the result list
  regardless of `community_classroom` / `community_events`.
- When the caller taps a hit whose dependent surface is dark, the screen sets
  `unavailableKind` and shows a calm transient "not available" notice instead of
  navigating into an unregistered route (F8 containment).
- The screen comment (`CommunityFindScreen.tsx:66-70`) is explicit: "a hit can
  appear for a surface that is dark for this caller, so we must not navigate into
  an unregistered route."

This DIFFERS from the task brief's described algorithm (exclude the hit from the
result set). The brief asks the backend search handler to do server-side
**exclusion**; the mobile client today does client-side **open-guard**. The
backend builder must DECIDE whether server-side γ should exclude hits (brief) or
whether the client open-guard remains the only γ (status quo). See spec §9.

## The kind→flag mapping (extracted, exhaustive)
Derived from the `open()` switch above:

| Community kind | Mapped server flag | Behavior when flag OFF | Source |
| --- | --- | --- | --- |
| `post` | (none) | passthrough — always opens `CommunityThread` | `CommunityFindScreen.tsx:122` |
| `voice_note_transcript` | (none) | passthrough — always opens `CommunityVoiceNoteDetail` | `:124-131` |
| `classroom_lesson` | `community_classroom` | open-guarded → "not available" notice | `:135-145` |
| `event` | `community_events` | open-guarded → "not available" notice | `:146-155` |

Note: `community_search` gates the WHOLE surface (`runtimeEnabled`,
`CommunityFindScreen.tsx:72`), and `coach_community_wearable_prompts` gates a
SEPARATE screen (`CommunityWearablePromptsScreen.tsx:80`) — neither maps to a
search kind.

## Analytics kind→type map (NOT a flag — included for completeness)
`CommunityFindScreen.tsx:103-112`:
```ts
const kindToResultType = {
  post: 'thread',
  voice_note_transcript: 'voice_note_transcript',
  classroom_lesson: 'classroom_lesson',
  event: 'event',
};
```
