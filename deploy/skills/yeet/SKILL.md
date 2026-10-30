---
name: yeet
description: Publish a scoped repair PR and satisfy the consumer's review and CI gates.
---

Read the dispatcher constitution and target repository instructions. This skill
inherits their authorization; it never enables AUTO_MERGE or overrides DRY_RUN.

Commit only the intended change with a conventional commit message, push a feature
branch and create a concise PR with problem, solution and validation. Use the
target repository's template. Wait for required CI and the configured automated
review. Read actual review comments, fix substantive findings and verify the
current commit is covered. Do not duplicate an automatic review request.

Respect the three-round review limit across previous runs. A remaining blocker
means leave the PR for operator review. Never use administrator bypasses, merge
red checks or silently ignore a substantive finding. Merge only if AUTO_MERGE is
enabled and all target-repository gates authorize it. Installer/deployer/IAM and
consumer-authorization changes always need operator review. After merging,
follow the constitution's ticket handoff; do not claim production recovery from
a merge alone.
