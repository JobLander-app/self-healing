# Codex fallback authentication

The installer pins Codex CLI 0.153.4 and creates a dedicated `.codex-shl` home.
Credentials refresh in place; never copy a workstation auth.json over it.
Use the Linux account configured by your consumer (`selfheal` below):

```sh
sudo -u selfheal -H env CODEX_HOME=/home/selfheal/.codex-shl \
  python3 dispatcher/scripts/codex-session.py /usr/bin/codex login --device-auth
```

All login/exec paths share the wrapper's lock, preventing concurrent reuse of a
refresh token. Keep the directory mode 700 and auth/config files mode 600. Check
`command -v codex`; the binary path can differ from this example. Verify a model
available to that account before setting `CODEX_ENABLED=true` and `CODEX_MODEL`.

`dispatcher/scripts/smoke-fallback.js` simulates a Claude quota failure and runs a
real read-only Codex no-tools probe with isolated temporary state. Run it on the
authorized VM after building the dispatcher; it consumes model access but does
not create an incident. A successful smoke proves authentication and that one
turn, not an unattended production repair.

The normal runner keeps existing gh/gcloud credentials for its authorized tools,
uses ephemeral sessions and excludes API-key variables from the Codex child.
Readiness needs successful evidence for the current credential fingerprint, not
just an auth file. An authentication failure suspends attempts until credentials
change. See [all harnesses](../dispatcher/README.md) for fallback behavior and
OpenCode/OpenRouter configuration.
