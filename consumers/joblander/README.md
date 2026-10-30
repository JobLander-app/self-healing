# JobLander consumer

This directory isolates the existing production deployment: profile, monitored
targets, voice/billing/duplicate-worker adapter, routing policy and Terraform root.
New consumers must use `consumers/example`, not these resource IDs or state bucket.

The Terraform root moved from `infra/terraform/self-healing` to `terraform/`
inside this directory. Its backend, module addresses and existing input values
are preserved. Conditional bucket/product-output resources include Terraform
`moved` blocks. Initialize the same backend from the new root and inspect the
plan; any unexpected replacement/destruction is a migration failure. Do not
apply the generic root against this state. The new GCP dashboard is additive.

The runtime profile preserves the Linux user, watch threshold, service targets,
legacy state directories and monitor lock. Adapter regression tests preserve the
product's monitoring behavior. The generic constitution now requires a
false-positive label even on a first verdict; it no longer writes new local
wildcard suppressions.

Before rollout, a reviewed CI provisioning change must install the non-secret
`/etc/self-healing/profile.json` link to this profile and a root-owned
`/etc/self-healing/deploy.env` with:

```sh
SH_DIR=/home/joblander/self-healing
AGENT_USER=joblander
SELF_HEALING_PROFILE=/home/joblander/self-healing/consumers/joblander/profile.json
DEPLOY_MONITOR_LOCK=/tmp/joblander-Monitor.lock
```

Stage the new profile/targets/policy/adapter from the reviewed release before
activation. Validate them with `config/run.py --check` under the service's effective
environment; preserve existing credentials and state. This is provisioning through
CI, not an instruction to restart the production runner or run the full installer.
Without this contract the new deploy script defers before runtime replacement.
The normal transactional deploy then renders profile-based units/cron and waits
for the existing locks. Preserve rollback artifacts, credentials and old state.

No production profile installation, infrastructure apply, service restart or
runtime validation is implied by the repository refactor itself. Validate the
reviewed migration plan and observed rollout before claiming continuity is proven.
