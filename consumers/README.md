# Consumer boundary

A consumer is a directory with version-1 `profile.json`, `targets.json` and
`policy.md`. `config/run.py --profile <file> -- <command>` validates the files,
merges non-secret profile values with the process environment (process wins),
and passes absolute paths to services. `/etc/self-healing/profile.json` selects
the VM's consumer. No profile is chosen from the current developer's account.

`targets.json` contains `project`, `services`, `regions`, `cloud_run_services`,
`cloud_functions`, optional `livekit`, `voice_agents` and `retired_resources`.
Empty optional integrations are valid. Scope changes are reviewed configuration;
a target removed intentionally must never be recreated by an agent.

An optional Python file selected by `monitor_adapter` implements:

- `configure(core)`: receives shared grouping, log-query and sanitization helpers.
- `collect(groups, topology)`: adds product signals and returns the four context
  arguments consumed by `severity` (default `({}, 0, 0, 0)`).
- `severity(groups, stage_counts, audio_timeouts, geo_misroutes, avatar_failures)`:
  applies product-specific severity after generic count thresholds.
- `services(status_callback, topology)`: returns additional service summary data.
- `page(group)`: requests a page for a product-specific critical condition.

Adapters are trusted local Python code, not sandboxed plugins. Keep business
rules, resource identifiers and their tests in the consumer directory. Use the
example with no adapter for a basic Cloud Run setup. Provider harnesses and
tracker suppression belong to the core, shared by every consumer.
