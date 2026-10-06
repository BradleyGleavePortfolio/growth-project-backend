import re,glob,os
files=sorted(glob.glob('prisma/migrations/*/migration.sql'))
big=''
for f in files:
    big+='\n'+re.sub(r'--[^\n]*','',open(f).read())
tables=["community_workspaces","community_cohorts","community_memberships","community_messages","community_posts","community_responses","community_events","community_event_rsvps","community_challenges","community_challenge_participations","community_moderation_actions","community_classroom_posts","community_classroom_media_assets","community_voice_notes","community_search_entries","community_wearable_prompts","community_wearable_prompt_sources","community_reports","CommunityWin","RomanSession","RomanMessage","WorkoutProgram","WorkoutPlanRevision","WorkoutProgramRevision","ClientWorkoutAssignmentSnapshot","CoachBookingOption","AiProcessingConsentEvent"]
for t in tables:
    q=re.escape(t); tp=r'(?:"?public"?\.)?"?'+q+r'"'+r'?'
    en=bool(re.search(r'ALTER TABLE (?:ONLY )?(?:IF EXISTS )?'+tp+r'\s+ENABLE ROW LEVEL SECURITY',big,re.I))
    fo=bool(re.search(r'ALTER TABLE (?:ONLY )?(?:IF EXISTS )?'+tp+r'\s+FORCE ROW LEVEL SECURITY',big,re.I))
    rv=bool(re.search(r'REVOKE[^;]*ON (?:TABLE )?[^;]*'+tp+r'[\s,;][^;]*FROM[^;]*anon',big,re.I))
    pols=re.findall(r'CREATE POLICY\s+"?([^"\s]+)"?\s+ON\s+'+tp+r'\s([^;]*);',big,re.I)
    drops=re.findall(r'DROP POLICY (?:IF EXISTS )?"?([^"\s]+)"?\s+ON\s+'+tp+r'\s',big,re.I)
    print(f"{t}: enable={en} force={fo} revoke_anon={rv} create_policies={len(pols)} drops={len(drops)}")
    for n,b in pols:
        b=' '.join(b.split())
        if re.search(r'\bTO\s+(public|anon|authenticated)',b,re.I) or not re.search(r'\bTO\b',b):
            print('    ',n,':',b[:200])
