#!/usr/bin/env bash
#
# The only sanctioned way to apply this root.
#
# WHY IT EXISTS. On 2026-09-02 `terraform apply` was run from a checkout that
# predated the watchdog module. Terraform did exactly what it was told: the
# module was absent from the configuration, so it DESTROYED it — service
# account, IAM, both functions, the scheduler, the state bucket. The loop lost
# its off-box recovery layer for twenty minutes, and only a stale local checkout
# stood between "apply" and "delete the safety net".
#
# This is a repeat. The 2026-07-28 review recorded four wrong conclusions in one
# week, three of them "from reading a local checkout five commits behind". The
# difference is that reading stale code produces a wrong opinion, while applying
# stale infrastructure-as-code produces a wrong production.
#
# So: this root is applied from a checkout that matches origin/main, or it is
# not applied.
#
#   ./apply.sh              plan, confirm, apply
#   ./apply.sh --auto       no confirmation (CI / automation)
#   ./apply.sh --plan-only  plan and stop
set -euo pipefail

cd "$(dirname "$0")"
REPO_ROOT="$(git rev-parse --show-toplevel)"

AUTO=0
PLAN_ONLY=0
for a in "$@"; do
  case "$a" in
    --auto) AUTO=1 ;;
    --plan-only) PLAN_ONLY=1 ;;
    *) echo "unknown argument: $a" >&2; exit 2 ;;
  esac
done

die() { printf '\n\033[31mREFUSING TO APPLY\033[0m: %s\n\n' "$1" >&2; exit 1; }

# ---- 1. the checkout must be current ---------------------------------------
git -C "$REPO_ROOT" fetch --quiet origin main || die "cannot reach origin — apply blind and you may destroy what main declares"
LOCAL="$(git -C "$REPO_ROOT" rev-parse HEAD)"
REMOTE="$(git -C "$REPO_ROOT" rev-parse origin/main)"
if [ "$LOCAL" != "$REMOTE" ]; then
  BEHIND="$(git -C "$REPO_ROOT" rev-list --count "$LOCAL..$REMOTE" 2>/dev/null || echo '?')"
  AHEAD="$(git -C "$REPO_ROOT" rev-list --count "$REMOTE..$LOCAL" 2>/dev/null || echo '?')"
  die "checkout is ${BEHIND} commit(s) behind and ${AHEAD} ahead of origin/main.
  Anything main declares that this checkout does not know about would be DESTROYED.
  Fix with:  git -C $REPO_ROOT pull --ff-only origin main
  Or apply from a clean worktree:  git worktree add /tmp/tf origin/main"
fi

# ---- 2. no uncommitted infrastructure --------------------------------------
DIRTY="$(git -C "$REPO_ROOT" status --porcelain -- infra/ | grep -v '\.terraform' || true)"
if [ -n "$DIRTY" ]; then
  die "uncommitted changes under infra/ — commit them, or you are applying something no review has seen:
$DIRTY"
fi

echo "checkout matches origin/main at ${LOCAL:0:8}"
terraform init -input=false
terraform plan -input=false -out=.tfplan

# ---- 3. a destroy is never routine here ------------------------------------
# This root owns the loop's own recovery layer. Deleting from it is a decision,
# never a side effect of running the usual command.
DESTROYS="$(terraform show -json .tfplan \
  | python3 -c 'import json,sys; print(sum(1 for r in json.load(sys.stdin).get("resource_changes",[]) if "delete" in r["change"]["actions"]))')"
if [ "$DESTROYS" -gt 0 ]; then
  printf '\n\033[31m%s resource(s) would be DESTROYED.\033[0m\n' "$DESTROYS"
  echo "Read the plan above. If this is intended, re-run with TF_ALLOW_DESTROY=1."
  [ "${TF_ALLOW_DESTROY:-0}" = "1" ] || die "destroy not confirmed"
fi

[ "$PLAN_ONLY" = "1" ] && { rm -f .tfplan; exit 0; }

if [ "$AUTO" != "1" ]; then
  read -r -p "Apply this plan? [y/N] " reply
  case "$reply" in y|Y|yes) ;; *) rm -f .tfplan; echo "aborted"; exit 0 ;; esac
fi

terraform apply -input=false .tfplan
rm -f .tfplan
