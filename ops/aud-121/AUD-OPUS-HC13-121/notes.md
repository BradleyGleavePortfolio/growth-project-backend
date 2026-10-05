# AUD-OPUS-HC13-121 notes (Claude Opus 5.5 lens, agent 121) — scope: _COMMON_121 items 13-14 (RUTHLESS)

m#378 @ 2ea649a1bd9d4ba8f61c9c84f57e100df8b31fb7 (base main b79ca594; 11 files +1035/-20)
b#731 @ 958d340d480e569770345f38bd0130dcd7cb64ee (draft; base 5da537d6; 2 files +11/-2)

## m#378 checks (item list only)
- Wrong account: every request still runs fence.assertCurrent AFTER pacer.acquire (ingestBatching.ts:360-361; HK healthKitSyncService.ts:340-343; HC healthConnectSyncService.ts:332). A wait in the shared pacer (<= 60 s) ends in a fence check, so a sign-out/account switch during a wait sends nothing (test ingestPacing.hc12 'a session stop while waiting sends nothing'). Shared pacer holds only timestamps, no samples. OK.
- Data loss (HC look-back skip, lookBack.ts:62-71): skips a record only if wholly inside [windowStart, completedThrough) and lastModifiedTime <= completedThrough - 15 min. completedThrough is written only after every page of that read was posted (healthConnectSyncService.ts:339-345; a throwing ingest aborts before setSyncProgress). windowStart = completedThrough - 1 d >= previous read start, so the previous read's range contained the record and the record existed when it began. HC normalizer has no time-based drop (healthConnectNormalizer.ts:399-406), so "seen" == "posted". Resumed reads and first imports skip nothing (lookBack null when stored or no progress). No metadata -> never skipped. OK.
- Double count / loss (sleep): HC groups overlapping sessions per page; a night with a member seen by the last read posts nothing, else the most detailed. HK posts a session only from the piece whose [start-2h, end-2h) holds its end; consecutive pieces and consecutive runs (next run starts savedThrough - 1 d <= previous end) join without gaps, so a normal night is posted, whole, and nights ending within 2 h of run end wait for the next run exactly as rule 3 already did. OK.
- Sync that never finishes: pacer is a correct sliding window (acquire loop waits out hold then window; sent[] monotonic via clock()); 429 -> backOff <= 60 s, 3 attempts, final 429 holds the next run; progress per page/piece unchanged so runs resume. Large imports are paced at 50/min instead of tripping 429s (same order of throughput as main's 60/min + 60 s waits). OK.
- Crash: sleepSessionsToPost handles null spans; reduce has initial value; no throw paths added. OK.
- Store policy: no manifest/app.json/permission changes. False claims: no product copy changed (comments only). OK.
- C (edge, deferred to 10k clients) lookBack.ts:66 + lookBack.ts:121: a sleep session written within 15 min before a refresh does not count as "seen" on the next refresh; if a second sleep app later writes an overlapping, more detailed session for that night, it is posted too and the night counts twice. Needs two sleep apps + opening TGP within 15 min of the first write; main double-counts this case always, so #378 is strictly better. Fix rule: backend per-night replace (#732).

## b#731 checks
- Manifest value unset -> "true" + note; runbook section. Flag parsing: on-device-ingest.feature.ts:19-21 literal 'true' (case-insensitive) = on, anything else typed 503 wearables_ingest_disabled on both connect and ingest routes; runbook rollback ("unset") and 503 claim are true. Backend code is in prod main 5da537d6 (PR base), so "no deploy needed" is true. mergeable true (main now 4bddf24a).
- C (doc) docs/runbooks/launch-flags.md:146: the owner device pass should name a build/OTA that contains m#378 (an older H1-H8 binary would burst into 429s). Fix rule: add "on a build or OTA that includes mobile #378".

## CI
- m#378 PR CI at head: Typecheck/lint/test cancelled; CodeQL cancelled. b#731: build-and-test and others cancelled, comment-deploy-readiness failure (follows the cancel). Not re-triggered (item 12). Needs a green PR CI run before merge.
- Local evidence: heavy.sh one spec (healthConnectSyncService.hc12.test.ts) at head, log heavy-hc12-hc.log.
