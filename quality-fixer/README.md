# quality-fixer — the consumer end of the quality loop (JOB-777)

Quality-loop 3/3. Turns automatically-filed `[Quality]` tickets into **verified,
replay-gated, auto-merged** coach fixes.

```
quality-triage (JOB-775, workspace repo)        ── files ──▶  [Quality] tickets (Linear)
  Firestore practices/* where judge overall<=5                     │
                                                                   ▼
quality-fixer (this dir, JOB-777)  ── verification-first ▶ diagnose ▶ fix ▶ replay-gate ▶ auto-merge
  judge:  ai-voice-agent-python/src/services/quality_judge.py (JOB-762, CV-aware JOB-778)
  gate:   ai-voice-agent-python/scripts/stand/browser_harness/replay.py (JOB-776)
  coach:  ai-voice-agent-python/src/utils/prompt_builder.py
```

## Contents

- **`CLAUDE.md`** — the fix-agent constitution (the loop's brain). A run =
  one Claude Agent SDK session with this as its system prompt, processing exactly
  one `[Quality]` ticket to a terminal state. Mirrors the `[Monitor]`
  `dispatcher/CLAUDE.md`, with the quality-specific guardrails:
  verification-first, systemic-fix-only, the replay-gate, and the prompt-debt
  review.
- **`prompt-debt.js`** — the persistent prompt-debt counter (owner directive
  2026-07-19). Tracks point-edits to the coach ruleset since the last
  consolidation; at ≥3 (or a found contradiction) the fixer files a
  `[Quality] Refactor` ticket. State survives restarts (file on host, not
  memory): `$PROMPT_DEBT_STATE` or `~/.quality-fixer/prompt-debt.json`.

## The two guardrails that make this different from the Monitor fixer

1. **Verification-first (owner 2026-07-19).** A `[Quality]` ticket is a judge's
   *opinion*, and the judge is wrong in structured ways (JOB-778 CV blindness;
   JOB-790 rationale fabrication). The fixer's FIRST step validates the verdict
   against ground truth (transcript + session context + CV fact sheet). A false
   verdict is reclassified as a judge bug — the coach is never touched on a false
   accusation. (First live ticket JOB-780 was exactly this: fabricated "Gotcha".)
2. **Replay-gate = the merge authority.** A coach-behaviour change only merges if
   it is *measured* to help: the problem-case fail-rate drops (`replay`, N runs)
   AND the full regression matrix does not regress (`regression`, eps 0.5). No
   numbers → no merge. This is why auto-merge is safe for this class.

## Merge exception (codified in CLAUDE.md, both levels)

Auto-merge for `[Quality]` is the second sanctioned exception to "merge is
human-only" (after `[Monitor]`), added in the same JOB-777 change:
- workspace repo root `CLAUDE.md` → the Self-Healing Loop section.
- `ai-voice-agent-python/CLAUDE.md` → the merge-ban carve-out.
Strictly gated on the replay-gate passing.

## Hosting / what's left for full automation (JOB-791)

The Monitor dispatcher runs on the stand-less self-healing VM. The quality
replay-gate needs the **full browser stand** (Chromium + FE + a voice worker
built from the fix branch + SSH tunnel to `lk-eu-west4`), so this consumer cannot
just run there. **JOB-791** carries the two always-on hosting options (a
dedicated quality-stand VM, or a split brains-on-dispatcher + gate-on-stand-host)
with honest cost/complexity — the VM is an owner decision (terraform only).

**Until JOB-791 lands, the loop runs manually per cycle** on a stand-capable dev
box (verified feasible): a human triggers a run, the constitution's steps are
executed, and the first cycle's merge is confirmed by the coordinator. The
constitution + counter + CLAUDE.md exception below are host-agnostic and ready.

### Daemon integration (when a host exists)
Reuse the dispatcher machinery (`dispatcher/src` poller/session/config/trace/
pause/notify) with a **quality profile**: a self-poll tick that (a) pre-checks
Linear for `[Quality]`-title/`quality`-label Backlog tickets, and (b) spawns a
Claude Agent SDK session whose system prompt is **this** `CLAUDE.md` and whose
run-instruction is "process exactly one `[Quality]` ticket". Do NOT bolt the
quality flow onto the live `[Monitor]` constitution — keep them separate
constitutions sharing the daemon runtime, so the prod `[Monitor]` auto-merge path
is untouched. The `[QUALITY_RESULT]` marker is parsed exactly like
`[DISPATCH_RESULT]`.
