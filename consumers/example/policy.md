# Application policy

Replace this file before launching the loop. Describe the product output that
must reach users, how to reproduce failures, and how to distinguish an outage
from a quiet period. Map every monitored service to an approved TRACKED_REPOS
repository, its test command, required CI/review checks and deployment workflow.

Specify the allowed scope of repairs, data access and production operations.
Document planned shutdowns, environments the agent must avoid and the evidence
required to declare recovery. Keep credentials in Secret Manager, never here.
