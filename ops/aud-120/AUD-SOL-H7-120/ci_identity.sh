# BASH_ENV adapter for the required shared CI-lane launcher; only its stale
# commit identity is replaced, leaving the launcher/workflow untouched.
git() {
  local -a adjusted=()
  local arg
  for arg in "$@"; do
    case "$arg" in
      'user.name=TGP Agent 116') adjusted+=('user.name=Bradley Gleave') ;;
      'user.email=agent@tgp.invalid') adjusted+=('user.email=bradley@bradleytgpcoaching.com') ;;
      *) adjusted+=("$arg") ;;
    esac
  done
  command git "${adjusted[@]}"
}
