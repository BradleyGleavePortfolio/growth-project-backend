#!/bin/bash
# anonymous git (public repo) while the github credential preset returns 401
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
exec git -c user.name="Bradley Gleave" -c user.email="bradley@bradleytgpcoaching.com" "$@"
