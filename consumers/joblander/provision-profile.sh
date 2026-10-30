#!/usr/bin/env bash
# Called only by the reviewed main-branch GitHub workflow, through IAP.
set -Eeuo pipefail
release="${1:?expected main commit required}"
[[ "$release" =~ ^[a-f0-9]{40}$ ]]
checkout=/home/joblander/self-healing
agent=joblander

# Share the deployer's lock. Do not race a timer tick or interrupted rollback.
exec 9>/var/lock/self-healing-deploy.lock
flock -w 90 9
test ! -e /var/lib/self-healing-deploy/transaction.env
git_agent() { sudo -n -u "$agent" git -C "$checkout" "$@"; }
git_agent fetch --quiet origin main
test "$(git_agent rev-parse origin/main)" = "$release"
test -z "$(git_agent status --porcelain --untracked-files=no)"
git_agent merge-base --is-ancestor HEAD "$release"

stage="$(mktemp -d /var/tmp/self-healing-profile.XXXXXX)"
trap 'rm -rf "$stage"' EXIT
chmod 755 "$stage"
git_agent archive "$release" | tar -x -C "$stage"
python3 "$stage/deploy/bin/provision-profile.py" \
  --source "$stage" --checkout "$checkout" --profile consumers/joblander/profile.json
# No systemctl start/restart, checkout reset, secret download or state mutation.
# Publishing deploy.env last enables the existing timer's transactional release.
