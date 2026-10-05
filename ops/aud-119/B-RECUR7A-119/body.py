import json,subprocess,sys,re
n,url,head=sys.argv[1],sys.argv[2],sys.argv[3]
R='BradleyGleavePortfolio/growth-project-backend'
body=json.loads(subprocess.check_output(['gh','api',f'repos/{R}/pulls/{n}']))['body']
body=body.replace('**Canonical builder:** ','**Canonical builder:** B-RECUR7A-119 (agent 119) for fix round 7; ',1)
if n=='678':
    body=body.replace('deletion yes (fix round 6:','deletion yes (fix round 7: the send fence and the unbound-attempt collector cover the coach as well as the client; fix round 6:',1)
    ev=('fix round 7 failing-before CI lane [run 37229770060](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37229770060) (5 failed / 8 on 77bce450); after [run 37230098522](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37230098522) (81/81); probe replay [run 37230108455](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37230108455) (incl. real-PostgreSQL fence). ')
    row=f'| 7 (B-RECUR7A-119) | {head[:8]} | Sol B-678-3 + Opus C-678-4 (deletion collects unbound attempts of client and coach), Sol B-678-4 (send fence holds both User rows FOR KEY SHARE in id order; claim re-proves the coach) (test 7ec88952, fix 7b0743cd, test 09e159d8); 2,594 lines | [{url.split("#issuecomment-")[1]}]({url}) |'
else:
    body=body.replace('deletion yes (fix round 6:','deletion yes (fix round 7: R1 fence now holds client and coach; fix round 6:',1)
    ev=('fix round 7 failing-before CI lane [run 37230129006](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37230129006) (5 failed / 8 on 8bbf4a41); after + probe replay [run 37230205968](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37230205968); tests in R5 #701. ')
    row=f'| 7 (B-RECUR7A-119) | {head[:8]} | Sol B-679-10 narrowed + Opus C-679-4 (no default-only settled trial), Sol B-679-11 (plan list complete for live plans, history capped after filtering) (fix eeb23f2e, merges of #678 e96786eb / 23d2c04c; tests #701 5e8f1ceb); 2,943 lines | [{url.split("#issuecomment-")[1]}]({url}) |'
body=body.replace('**Acceptance evidence:** ','**Acceptance evidence:** '+ev,1)
lines=body.split('\n')
idx=max(i for i,l in enumerate(lines) if l.startswith('| 6 (B-RECUR6A-118)'))
lines.insert(idx+1,row)
body='\n'.join(lines)
open(f'/tmp/b7a-body-{n}.md','w').write(body)
subprocess.check_call(['gh','api','-X','PATCH',f'repos/{R}/pulls/{n}','-F',f'body=@/tmp/b7a-body-{n}.md','--silent'])
print('updated',n)
