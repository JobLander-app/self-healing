# Project rules

Code, documentation, commits and dashboards use English.

Work in a dedicated git worktree based on `origin/main`. Keep the main checkout
untouched. Commit persistent changes with conventional commit subjects.
Push feature branches and open pull requests; never push directly to main.
Obtain an actual automated review of the current commit, resolve valid findings,
and wait for passing CI before merging. A green status alone is not a review.

The reusable core contains no customer identifiers or product rules. Put those in
`consumers/<name>/profile.json`, `targets.json`, `policy.md` and an optional Python
monitor adapter. Test both the core and affected consumer adapters.

Claude Agent SDK is primary; Codex CLI and OpenCode with OpenRouter are optional
fallbacks. Collection, queue selection, false-positive checks, change ingestion,
health probes and accounting are deterministic. Do not add separate model calls
for those tasks. Never blindly retry a task failure with another model.

Linear is the durable source of ticket decisions. A false-positive verdict must
label the original issue, preserve evidence and stop re-filing the same signature.
Do not add a separate database for these decisions. SQLite remains local storage
for the optional change feed.

Deploy only through the repository's reviewed release workflow. Changes to the
installer, Terraform and deployer require operator review. Tests and a local
build do not prove a production deployment succeeded. Never restart a production
runner as part of repository maintenance.
