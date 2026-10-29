# Agent setup runbook

1. Fork and clone the repository. Create a branch/worktree. Read the application
   repositories and identify actual production services/regions, deployment
   evidence, output invariant, test commands and review requirements. This
   deployment targets GCP/Cloud Run, GitHub and Linear; other platforms require
   adapters, not just renamed environment variables.
2. Copy `consumers/example` to `consumers/<your-app>`. Resolve real Linear UUIDs
   for the team and labels. Ensure workflow names include To Do, Backlog,
   In Progress, Done and a state with type `canceled`. Pre-create `false-positive`
   (the dispatcher can create it when permissions allow). Set approved owner/repo
   slugs, monitored services/regions, endpoint URL and Telegram chat. Fill in
   `policy.md` with routing, required review bot, package manager, tests and release
   workflow. The production profile is not a template for your account.
3. Validate the profile; placeholders intentionally fail a real check:

   ```sh
   python3 config/run.py --profile consumers/my-app/profile.json --check
   ```

   `--check --allow-example` validates only the example's structure. It cannot
   launch services. `WATCH_PATH` includes the query string; the HMAC signs only
   the path. Implement and test the [output contract](../watcher/README.md).
4. Create a GCS Terraform-state bucket and a new backend prefix. Enable billing
   and the APIs in `infra/terraform/self-healing/main.tf`; initial Terraform
   credentials need API/IAM provisioning rights. Runtime uses a dedicated service
   account. The default VPC/subnet must exist (or configure the module inputs).
5. Provision secrets outside Terraform so values do not enter state. The supplied
   deployment uses these names; grant access only to the selected secret IDs:

   | Secret | Content |
   | --- | --- |
   | `self-healing-dispatcher-env` | dotenv with `CLAUDE_CODE_OAUTH_TOKEN`, `TRIGGER_TOKEN`, `TG_BOT_TOKEN`; optional `OPENROUTER_API_KEY`, `CODEX_ENABLED`, `CODEX_MODEL`, `OPENCODE_ENABLED`, `OPENCODE_MODEL` |
   | `linear-api-key` | Raw Linear API key |
   | `self-healing-gh-token` | GitHub token scoped to the fork and approved target repos |
   | `claude-code-oauth-token` | Claude subscription OAuth token used by dependency checks |
   | `self-healing-output-hmac` | Shared watcher/health-endpoint signing secret |
   | `self-healing-trigger-token` | Same value as dispatcher `TRIGGER_TOKEN` |
   | `self-healing-telegram-env` | dotenv `TG_BOT_TOKEN` and `TG_CHAT_ID` for watcher/monitor |
   | `telegram-alert-bot-token`, `telegram-default-chat-id` | Bot token and chat id for the external watchdog/alert relay |
   | `self-healing-grafana-admin` | Strong unique Grafana admin password |

   Optional Sentry needs organization, project ID, service name and token secret
   in the profile. Firebase needs `FIREBASE_ENABLED=true` and matching Terraform
   opt-in. Do not copy raw application `.env` files into agent environments.
   Secret environment values override profile values; inspect effective dry-run
   and auto-merge settings before enabling services.
6. Commit and push the configured fork before provisioning; the VM clones `main`.
   Copy the example backend/tfvars files in `infra/terraform/self-healing`, then:

   ```sh
   terraform -chdir=infra/terraform/self-healing init -backend-config=backend.hcl
   terraform -chdir=infra/terraform/self-healing validate
   terraform -chdir=infra/terraform/self-healing plan -var-file=terraform.tfvars -out=setup.tfplan
   ```

   Review resources, IAM, costs and destructive actions with the operator. Apply
   only the authorized plan through your deployment workflow. Do not use the
   JobLander backend. Set the console DNS A record from the Terraform output.
7. The installer creates the Linux account, pins/install CLIs, builds packages,
   selects `/etc/self-healing/profile.json`, renders services/cron and writes a
   non-secret root-owned `/etc/self-healing/deploy.env`. No Postgres is installed.
   Check installer TODOs and service status. OAuth login may need an operator;
   use [Codex authentication](CODEX-FALLBACK.md) for the optional fallback.
8. Verify before enabling live mode: health endpoint healthy/degraded/unknown;
   watcher threshold and recovery; one dry-run candidate; no queue means no model
   attempts; false-positive exact matching and severity override; pending outbox
   replay; required CI/review; Grafana auth and GCP dashboard; independent alert
   delivery and watchdog policy. Local fixture tests are not proof of these live
   outcomes. Test live writes in a dedicated test team/repo before production.
9. After explicit operator authorization set DRY_RUN=false. Leave AUTO_MERGE=false
   until review and deployment gates have been demonstrated. Configure spend
   limits, retention, backups and emergency stop. Record deployed commit,
   effective settings and observed outcomes in your fork's operations notes.
