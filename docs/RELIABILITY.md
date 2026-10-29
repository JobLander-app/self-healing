# Reliability boundaries

The loop has independent observation, investigation and off-box recovery paths.
The watcher pages sustained output loss; the monitor files scoped evidence; the
dispatcher serializes one selected repair. The off-box watchdog monitors prior
heartbeat evidence and can reset only its configured VM within a bounded budget.

Durable outboxes preserve paging, filing and false-positive writes over transient
API/provider failures. False positives live on Linear tickets; an exact matching
label pauses future filing for 24 hours on confirmations one and two, then 30 days
on confirmation three. Only investigations filed after the prior pause count;
expiry of the long pause resets the cycle. Increased severity and P0 bypass it. Queue selection, age limits and accounting
checks happen outside model reasoning.

Memory cgroups contain runaway investigations. Network recovery has bounded
escalation; deployment waits for activity and rolls back exact runtime artifacts.
Provider fallback is limited to availability failures with an unambiguous handover.
These mechanisms reduce failure modes, but cannot make every model conclusion or
repair correct. Required review, CI, credential scope and post-deploy evidence
remain essential.
