#!/usr/bin/env bash
set -euo pipefail
TZ=America/Los_Angeles date
gh api graphql -f query='
query {
  mobile: repository(owner:"BradleyGleavePortfolio",name:"growth-project-mobile") {
    pullRequests(first:100,states:OPEN,orderBy:{field:CREATED_AT,direction:ASC}) {
      nodes {
        number title url headRefName headRefOid
        comments(last:100) { nodes { createdAt url body } }
      }
    }
  }
  backend: repository(owner:"BradleyGleavePortfolio",name:"growth-project-backend") {
    pullRequests(first:100,states:OPEN,orderBy:{field:CREATED_AT,direction:ASC}) {
      nodes {
        number title url headRefName headRefOid
        comments(last:100) { nodes { createdAt url body } }
      }
    }
  }
}' --jq '
  .data | to_entries[] | .key as $repo |
  .value.pullRequests.nodes[] |
  select((.headRefName|startswith("agent126/fu-")) or .headRefName == "agent126/r11c-126-mobile") |
  {
    repo:$repo,number,title,url,headRefName,headRefOid,
    ready:[.comments.nodes[]|
      select(.body|test("^(FIX ROUND|RESTACK|STATUS)"))|
      {createdAt,url,line:(.body|split("\n")[0])}],
    sol:[.comments.nodes[]|
      select(.body|startswith("AUDIT GPT-6.1 Sol"))|
      {createdAt,url,line:(.body|split("\n")[0])}]
  }'
