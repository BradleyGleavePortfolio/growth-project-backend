import sys, subprocess, json
n, row, url = sys.argv[1], sys.argv[2], sys.argv[3]
repo="repos/BradleyGleavePortfolio/growth-project-backend/pulls/"+n
body=subprocess.run(["gh","api",repo,"--jq",".body"],capture_output=True,text=True,check=True).stdout.rstrip("\n")
row=row.replace("URL",url)
if row in body: print("row exists"); sys.exit(0)
body=body.replace("**Canonical builder:** agent 116 (B-D34-116 fix round 1)","**Canonical builder:** agent 116 (B-D34-116 fix round 1); restack B-DUN-117 (agent 117)")
body=body.replace("**Parent owner:** operator 116","**Parent owner:** operator 117")
if len(sys.argv)>5: body=body.replace(sys.argv[4],sys.argv[5])
lines=body.split("\n")
# append row after last table row of the Fix rounds table
idx=max(i for i,l in enumerate(lines) if l.startswith("| "))
lines.insert(idx+1,row)
body="\n".join(lines)+"\n"
open(f"/home/user/workspace/ops/aud-117/B-DUN-117/body_{n}_new.md","w").write(body)
subprocess.run(["gh","api","-X","PATCH",repo,"-F",f"body=@/home/user/workspace/ops/aud-117/B-DUN-117/body_{n}_new.md","--jq",".number"],check=True)
