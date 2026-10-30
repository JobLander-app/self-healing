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

## Reviewed production migration

The manually dispatched **Provision production profile** GitHub Actions workflow
installs this contract from the current `main` commit through IAP. It does not run
the installer, change credentials/state, reset the checkout or restart services.
It holds the deployment lock, rejects a dirty/diverged checkout or interrupted
transaction, validates the staged profile with both running services' environment
overrides, and publishes `deploy.env` last. The link may be dangling briefly until
the normal timer activates the release. A failed or repeated provisioning run is
safe; an existing different contract requires a reviewed migration.

Before its first run, bootstrap the keyless CI identity from `deploy-access/`:

```sh
terraform -chdir=consumers/joblander/deploy-access init
terraform -chdir=consumers/joblander/deploy-access plan -out=access.tfplan
# Inspect: identity/IAP API activation, a dedicated account, custom role and additive IAM grants.
terraform -chdir=consumers/joblander/deploy-access apply access.tfplan
```

Apply only the reviewed commit and inspected plan. This separate bootstrap state
contains no VM/disk/startup-script resources. It explicitly enables IAM,
IAM Credentials, Security Token Service and IAP before configuring access, and
never disables those shared APIs on
teardown. The existing identity pool is reused;
only this repository's `main` token can impersonate the new account. The account
can discover compute resources, install an expiring SSH key on this VM, connect
through its IAP tunnel and act as its runtime identity. It cannot reset/delete the
VM or administer project IAM. SSH grants administrative access inside this VM;
protect `main` and review workflow changes accordingly. See Google's
[keyless authentication](https://github.com/google-github-actions/auth) and
[IAP SSH documentation](https://cloud.google.com/compute/docs/connect/ssh-using-iap).

Before activating the profile, update the old VM startup metadata: its previous
installer copies service templates verbatim and cannot handle portable profiles
on a later reboot. The one-time Cloud Build migration consumes an exact reviewed
GitHub commit and uses the existing build identity; no new broad project grants
are added to the GitHub provisioning identity.

```sh
# Run from a clean, synchronized main checkout after review and green CI.
gcloud builds submit https://github.com/JobLander-app/self-healing \
  --git-source-revision="$(git rev-parse HEAD)" \
  --config=consumers/joblander/terraform/cloudbuild-migration.yaml \
  --project=meet-assistant-6d8ad --region=europe-west1
# After the build succeeds:
gh workflow run provision-profile.yml --ref main
```

The build plans and validates before applying the same saved plan. It permits
only the new dashboard/three metrics, startup-script metadata, and wording-only
agent/alert updates required by the existing state moves. It rejects replacement,
deletion, changes to any other VM field, alert thresholds/routes, and unrelated
resources. Terraform targets include both old/new moved addresses; this is an
exceptional migration, not a general deployment recipe. It does not run startup
scripts or reboot the host. The separate GitHub workflow then publishes the
profile contract and the ordinary VM timer performs runtime activation.

The workflow waits for the existing deployment timer and requires the expected
commit, active services, healthy accounting, readable change feed and a cleared
transaction for a full minute. It reports provider readiness separately: old
provider evidence is not proof of a new successful model session. Check new
monitor/watcher heartbeats and runtime logs after deployment. Unrelated Terraform
changes, including watchdog build-artifact updates, are intentionally deferred.
