---
name: yeet
description: "Ship requested repository changes through commit, push, non-draft PR, actual automated review, fixes, squash merge when green, and production verification. Global delivery workflow copied from the user's Claude Code yeet command."
---

Ship code: stage, commit, push, open PR, get reviews, fix them, then merge when green and monitor prod — full delivery flow.

## Input

$ARGUMENTS — optional description for branch/commit/PR. If empty, infer from the diff.

**Flags:**
- `--codex` (or the word `codex` in arguments) — ALSO run a Codex review in addition to CodeRabbit. Use for complex / high-risk / architectural changes when a second strong opinion is wanted.

## Prerequisites

- `gh` CLI must be installed and authenticated. Check with `gh auth status`.
- Must be in a git repository.

## Reviewer model (READ FIRST)

- **Auto-run is per-repo — VERIFY, do not assume.** On `joblander.app` both reviewers have historically auto-run on PR open / each push. On `backend`, `chrome-extension`, and `self-healing`, CodeRabbit's **auto incremental reviews are DISABLED** — it answers `Review skipped — Auto incremental reviews are disabled on this repository`, so its silence there means nobody called it, not that it is busy. Trigger it explicitly with `@coderabbitai full review` when needed. Codex may run through a CI workflow or the native GitHub connector; verify the current repository's integration and the reviewed commit.
  - **CodeRabbit** (`coderabbitai[bot]`) — posts a summary + inline findings. Frequently **rate-limited** ("review limit reached, next review in N min"); when that happens it has NOT actually reviewed, so its "pass" check is a placeholder, not a verdict.
  - **Codex** (`chatgpt-codex-connector[bot]`) — posts a verdict comment ("Didn't find any major issues" or inline findings); a separate `codex-review` CI check exists only where configured.
- `--codex` (or the word `codex` in arguments) forces an extra explicit `@codex review` re-trigger if you want a fresh second opinion.
- The **merge gate** (step 6) needs at least ONE reviewer satisfied. **A clean Codex verdict alone is enough** — whether CodeRabbit is rate-limited, silent, or not enabled on that repo. Codex substitutes for CodeRabbit (owner 2026-09-01, supersedes the 2026-07-20 rule that required both).
- **Check status ≠ review verdict.** CodeRabbit's PR status check shows `pass` even when its review posted actionable Major/Critical inline findings — a COMMENTED review never fails the check. `gh pr checks` tells you NOTHING about comments; the only source of truth is the three comment endpoints in step 4. Never conclude "review clean" from a green check (2026-07-04 incident: two Major findings shipped past a "pass" check unread).

## Naming conventions

- Branch: `{type}/{description}` (e.g. `feat/add-email-scan`, `fix/pool-timeout`). Infer type from changes: feat, fix, chore, refactor, perf, docs.
- Commit: conventional commit format `{type}: {description}` — terse, focused on "why".
- PR title: same as commit message, under 70 characters. **Never** add a bracketed prefix (e.g. `[JA]`) before the type — squash-merge feeds the title to semantic-release and a prefix breaks the release.

## Workflow

### 1. Prepare

- Run `git status -sb` and `git diff --stat` to understand what changed.
- If on main/master/default branch, create a feature branch.
- Otherwise stay on the current branch.

### 2. Commit

- Stage relevant files (prefer specific files over `git add -A` — never stage .env, credentials, or large binaries).
- Write a conventional commit message. Only add co-author attribution when it accurately identifies the agent that performed the work; do not attribute Codex work to Claude.
- Use HEREDOC for multi-line messages.

### 3. Push & PR

- Push with tracking: `git push -u origin $(git branch --show-current)`
- If no PR exists for this branch, create one:
  ```
  gh pr create --title "{title}" --body "$(cat <<'EOF'
  ## Summary
  <detailed prose: what changed, why, impact>

  ## Test plan
  - [ ] <concrete verification steps>

  <!-- Use accurate authorship; omit agent branding if not needed. -->
  EOF
  )"
  ```
- PR description must be detailed enough that a reviewer can infer what was intentionally changed vs left alone.

### 4. CodeRabbit review — wait & poll (DEFAULT)

CodeRabbit auto-reviews ONLY where auto incremental reviews are enabled (see Reviewer model). Trigger it yourself where disabled, unless an actual current-head review is already running or a clean Codex verdict satisfies the gate. Detect {owner}/{repo} with `gh repo view --json owner,name`.

- Wait ~60–90 seconds after the push, then poll ALL THREE endpoints for `coderabbitai`:
  ```
  gh api repos/{owner}/{repo}/issues/{number}/comments --jq '[.[] | select(.user.login | test("coderabbit"; "i")) | {body, created_at}]'
  gh api repos/{owner}/{repo}/pulls/{number}/comments  --jq '[.[] | select(.user.login | test("coderabbit"; "i")) | {path, line, body}]'
  gh api repos/{owner}/{repo}/pulls/{number}/reviews   --jq '[.[] | select(.user.login | test("coderabbit"; "i")) | {state, body}]'
  ```
  - `/issues/{n}/comments` — the high-level summary + walkthrough comment (primary "it ran" signal).
  - `/pulls/{n}/comments` — inline, line-anchored findings (the actionable ones).
  - `/pulls/{n}/reviews` — the review wrapper / status.
- If all empty, retry up to 5 times at 60s intervals (CodeRabbit usually lands in 1–3 min).
- **Force a re-review only if needed:** `gh pr comment {number} --body "@coderabbitai review"` (incremental) or `@coderabbitai full review` (from scratch).
- **Rate-limit budget (наш план ограничен — соблюдаем, owner 2026-07-15):**
  - Проверить остаток БЕЗ расхода ревью: `gh pr comment {number} --body "@coderabbitai reviews remaining?"` (или `@coderabbitai rate limit`) — бот ответит remaining + когда восстановится.
  - Ревью расходуются на КАЖДЫЙ пуш в PR (auto-review). Экономия: батчить коммиты и пушить пакетами по завершении осмысленного чекпоинта, НЕ пушить WIP-коммиты поштучно в открытый PR.
- **Rate-limit hit → таймер, но мерж НЕ блокируется (owner 2026-09-01):**
  Если есть чистый вердикт Codex на текущую голову — мержим, CodeRabbit не ждём. Таймер ставим только когда Codex-вердикта нет. Если бот ответил «Review limit reached»:
  1. Распарсить из его комментария время восстановления («Next review available in: **N minutes**»).
  2. Поставить таймер на это время (background task: `sleep N*60` → notification; или Monitor/wakeup), НЕ бросать PR.
  3. Когда таймер сработал — триггернуть `gh pr comment {number} --body "@coderabbitai review"`, дождаться реального ревью (step 4 poll) и обработать находки (step 5).
  4. «pass»-чек при rate-limit — заглушка, не вердикт; PR без реального CodeRabbit-ревью не считается отревьюенным.
- **Done condition:** CodeRabbit posted a summary/walkthrough OR inline findings. A summary that says no actionable issues is a valid terminal state — proceed to step 5.
- **NEVER** close out /yeet on "didn't see comments" — that means you polled the wrong endpoint or didn't wait long enough.

### 4b. Codex review — opt-in ONLY

Skip this entirely unless `--codex` was passed or you judged the change complex/high-risk.

- Check if a Codex review already exists (don't double-trigger):
  ```
  gh api repos/{owner}/{repo}/issues/{number}/comments --jq '[.[] | select(.user.login | test("codex"; "i"))] | length'
  gh api repos/{owner}/{repo}/pulls/{number}/comments  --jq '[.[] | select(.user.login | test("codex"; "i"))] | length'
  ```
- If none, comment `@codex review`. Wait ~60s, then poll BOTH `/issues/{n}/comments` (summary verdict — the PRIMARY Codex signal, even "no major issues") and `/pulls/{n}/comments` (inline findings) for `chatgpt-codex-connector`. Retry up to 5× at 60s (Codex can take 3–6 min).
- Done condition: an explicit Codex verdict on either endpoint.

### 5. Fix ALL valid comments

**Do NOT ask whether to fix. Every valid comment gets fixed. Period.** Treat CodeRabbit and (if run) Codex comments the same way.

For each comment:
- Read the file and understand context.
- Fix Bug/Critical/Potential-issue findings — these are blockers.
- Fix Suggestion/nitpick if clearly correct.
- If the tool provides a committable `suggestion` / prompt block → apply it (after sanity-checking it's correct).
- If the comment describes a problem without a suggestion → fix using your judgement.
- If the comment is genuinely wrong (factually incorrect about the language/framework) → skip it, but explain WHY in your output. For CodeRabbit you may also reply on the thread to dismiss it.

After fixing all comments:
- Commit: `fix: address review comments on PR #{number}`
- Push. CodeRabbit auto-incremental-reviews the new commit; re-poll (step 4) and repeat until clean.

### 6. Merge when green + a reviewer is satisfied

Once all review comments are fixed and pushed, and CI has settled:
- **Merge requirement:** (a) ALL required status checks pass (build, etc. — not pending, not failing), AND (b) at least ONE reviewer is satisfied — CodeRabbit posted a clean / no-actionable-issues summary, OR Codex posted a clean verdict ("no major issues") — with NO unresolved blocking (Bug / Critical / P1) findings from either, AND (c) every inline finding pulled from the step-4 comment endpoints is either fixed or explicitly dismissed with a stated reason — verified against the endpoints, never against check statuses.
- **Codex substitutes for CodeRabbit (owner 2026-09-01).** A clean Codex verdict on the CURRENT head satisfies the gate on its own — do not wait for CodeRabbit when it is rate-limited, silent, or disabled on the repo. Only when there is no Codex verdict either do you set the reset timer (step 4) and wait. Watch the head: a verdict issued before your latest fix does not cover it — re-trigger `@codex review` after every push that changes code.
- Merge: `gh pr merge {number} --repo {owner}/{repo} --squash`. Rely on green checks — do NOT use `--admin`. If branch protection blocks it (a required review is missing) → report it, don't force.
- Do NOT merge with an unresolved blocking finding, a red or pending required check, or a CONFLICTING state.

### 7. Monitor prod after merge

Discover the repository's actual deployment path and verify the merged commit reached its runtime. JobLander application repos may use Cloud Build → Cloud Run; `self-healing` uses a pull-based systemd deployment timer on its VM. Other repositories may have different targets or no production runtime.
- Watch the applicable deploy checks or deployment logs to success, and verify the running revision.
- Then check the relevant production logs and health for NEW errors for a few minutes — use the `jl-prod-errors` skill if available and applicable, otherwise the runtime's own logs and health checks.
- If new P0/P1 errors correlate with the change → alert the owner and prepare a revert or fix immediately.

### 8. Done

- Output the PR URL + merge commit.
- Report: which reviewers ran and their verdicts, comments found / fixed / skipped (with reasons), the merge result, and the prod-monitor outcome.

## Rules

- NEVER ask "should I fix this?" or "should I commit?" or "should I push?" or "should I merge?" — just do it.
- Merge is ALLOWED once green + a reviewer is satisfied (step 6): always via `gh pr merge --squash` of a PR — never a direct `git push`/`git merge` to main, never `--admin`.
- NEVER use `--no-verify` or skip hooks.
- NEVER force push unless explicitly asked.
- Verify reviewer auto-run behavior per repository as described above; `--codex` forces an extra explicit re-trigger when required.
- Detect {owner}/{repo} from `gh repo view --json owner,name`.
