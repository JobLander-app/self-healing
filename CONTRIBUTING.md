# Contributing

Use English code/docs and conventional commits. Work in a feature worktree based
on origin/main. Keep customer identifiers and business rules under consumers.
Do not commit credentials, generated builds, Terraform state or local databases.

Run package builds/tests for changed Node components, Python monitor and affected
consumer tests, deployment failure tests, shellcheck and Terraform validation.
CI runs these checks without cloud credentials. Add behavioral tests for changes
to suppression, provider handover, accounting and deployment recovery.

Describe the problem, resulting behavior and validation in a concise PR. A local
fixture is not production evidence. Installer, deployment, IAM and authorization
changes require operator review; opening a PR does not authorize deployment.

Contributions use the MIT license. Preserve authorship and third-party notices.
